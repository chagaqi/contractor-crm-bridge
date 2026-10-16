import { describe, expect, it } from 'vitest';
import { Router, runLifecycle, runSimulation, signJwt } from '@ccb/core-api';
import { createMondayShell, DEFAULT_MONDAY_COLUMNS, type MondayConfig } from '../src/index.js';
import { makeEngine, mockFetch, request, type MockCall } from '../../core-api/test/helpers.js';

const API = 'https://monday.mock/v2';

function setup(config: MondayConfig = {}, existingItem: string | null = null) {
  const { engine } = makeEngine({ adapters: [] });
  const mock = mockFetch([
    {
      match: API,
      reply: (call: MockCall) => {
        const q = (call.body as { query: string }).query;
        if (q.includes('items_page_by_column_values')) return { data: { items_page_by_column_values: { items: existingItem ? [{ id: existingItem }] : [] } } };
        if (q.includes('create_item')) return { data: { create_item: { id: 'item_1' } } };
        return { data: { ok: true } };
      },
    },
  ]);
  const shell = createMondayShell(
    { engine, publicUrl: 'https://bridge.test', fetchImpl: mock.fetch, appSecret: 'app' },
    { apiToken: 'mon_tok', boardId: '123', apiUrl: API, signingSecret: 'sign', ...config },
  );
  engine.addAdapter(shell.adapter);
  const router = new Router();
  shell.registerRoutes(router);
  const gql = () => mock.calls.filter((c) => c.url === API).map((c) => c.body as { query: string; variables: Record<string, string> });
  return { engine, shell, router, mock, gql };
}

const jwt = (claims: Record<string, unknown> = {}) => signJwt({ accountId: 9, userId: 1, ...claims }, 'sign', { expiresInSeconds: 60 });

describe('monday.com shell', () => {
  it('creates a board item with phone/email/LTV column values and the API version header', async () => {
    const { engine, mock, gql } = setup();
    await runSimulation(engine, { source: 'jobber', scenario: 'customer_created', persona: 0 });
    expect(mock.calls[0]!.headers.authorization).toBe('mon_tok');
    expect(mock.calls[0]!.headers['api-version']).toBe('2024-10');
    const create = gql().find((b) => b.query.includes('create_item'))!;
    const vals = JSON.parse(create.variables.vals!);
    expect(create.variables).toMatchObject({ board: '123', name: 'Maria Gonzalez' });
    expect(vals[DEFAULT_MONDAY_COLUMNS.phone]).toEqual({ phone: '+15125550142', countryShortName: 'US' });
    expect(vals[DEFAULT_MONDAY_COLUMNS.email]).toEqual({ email: 'maria.gonzalez@example.com', text: 'maria.gonzalez@example.com' });
    expect(vals[DEFAULT_MONDAY_COLUMNS.sources]).toBe('jobber');
  });

  it('updates the existing item found by bridge-id column', async () => {
    const { engine, gql } = setup({}, 'item_42');
    await runSimulation(engine, { source: 'housecallpro', scenario: 'customer_created' });
    expect(gql().some((b) => b.query.includes('change_multiple_column_values') && b.variables.item === 'item_42')).toBe(true);
    expect(gql().some((b) => b.query.includes('create_item'))).toBe(false);
  });

  it('triggers move the status column and post an update on the item', async () => {
    const { engine, gql } = setup();
    await runLifecycle(engine, { source: 'buildertrend', persona: 5 });
    const statuses = gql()
      .filter((b) => b.query.includes('change_multiple_column_values') && b.variables.vals?.includes('"label"'))
      .map((b) => JSON.parse(b.variables.vals!)[DEFAULT_MONDAY_COLUMNS.status].label);
    expect(statuses).toEqual(['Estimate approved', 'Tech dispatched', 'Job completed', 'Paid', 'Paid ($500+)', 'Ask for review']);
    expect(gql().filter((b) => b.query.includes('create_update'))).toHaveLength(6);
  });

  it('recipe trigger: JWT-verified subscribe → output fields POSTed to webhookUrl → unsubscribe', async () => {
    const { engine, router, mock } = setup({ boardId: undefined });
    expect((await request(router, 'POST', '/monday/triggers/job_completed/subscribe', { body: { payload: { webhookUrl: 'https://x' } } })).status).toBe(401);
    const sub = await request(router, 'POST', '/monday/triggers/job_completed/subscribe', {
      body: { payload: { webhookUrl: 'https://monday.mock/hook/1', subscriptionId: 55, recipeId: 7 } },
      headers: { authorization: jwt() },
    });
    expect(sub.json.webhookId).toMatch(/^mwh_/);
    await runSimulation(engine, { source: 'fieldedge', scenario: 'job_completed', persona: 3 });
    const hook = mock.calls.find((c) => c.url === 'https://monday.mock/hook/1')!;
    expect(hook.headers.authorization).toBe('sign');
    expect(hook.body).toMatchObject({ trigger: { outputFields: { trigger: 'job_completed', contact_phone: '+14695550163', fsm_source: 'fieldedge' } } });
    await request(router, 'POST', '/monday/triggers/unsubscribe', { body: { payload: { webhookId: sub.json.webhookId } }, headers: { authorization: jwt() } });
    expect(engine.adapters.find((a) => a.id === 'monday')!.isConnected({ accountId: null, simulated: false, deliveryId: 'x' })).toBe(false);
  });

  it('rejects expired or wrongly-signed JWTs and unknown trigger keys', async () => {
    const { router } = setup();
    const expired = signJwt({ accountId: 1 }, 'sign', { expiresInSeconds: 1, now: Date.now() - 10_000 });
    expect((await request(router, 'POST', '/monday/triggers/job_completed/subscribe', { body: { payload: { webhookUrl: 'https://x' } }, headers: { authorization: expired } })).status).toBe(401);
    expect((await request(router, 'POST', '/monday/triggers/job_completed/subscribe', { body: { payload: { webhookUrl: 'https://x' } }, headers: { authorization: signJwt({}, 'other') } })).status).toBe(401);
    expect((await request(router, 'POST', '/monday/triggers/teleported/subscribe', { body: { payload: { webhookUrl: 'https://x' } }, headers: { authorization: jwt() } })).status).toBe(404);
  });

  it('sync_ltv_to_item action writes LTV with the short-lived token from the JWT', async () => {
    const { engine, router, mock } = setup();
    await runLifecycle(engine, { source: 'jobber', persona: 0 });
    const before = mock.calls.length;
    const res = await request(router, 'POST', '/monday/actions/sync_ltv_to_item', {
      body: { payload: { inboundFieldValues: { itemId: 999, boardId: 123, email: 'maria.gonzalez@example.com' } } },
      headers: { authorization: jwt({ shortLivedToken: 'slt_1' }) },
    });
    expect(res.json).toEqual({ found: true });
    const call = mock.calls[before]!;
    expect(call.headers.authorization).toBe('slt_1');
    expect(JSON.parse((call.body as { variables: { vals: string } }).variables.vals)[DEFAULT_MONDAY_COLUMNS.ltv]).toBe('650');
  });

  it('surfaces GraphQL errors as CRM failures in the delivery log', async () => {
    const { engine } = makeEngine({ adapters: [], retry: { attempts: 1, baseDelayMs: 0 } });
    const mock = mockFetch([{ match: API, reply: { errors: [{ message: 'Column not found' }] } }]);
    const shell = createMondayShell({ engine, publicUrl: 'https://b', fetchImpl: mock.fetch, appSecret: 'a' }, { apiToken: 't', boardId: '1', apiUrl: API });
    engine.addAdapter(shell.adapter);
    const { delivery } = await runSimulation(engine, { source: 'jobber', scenario: 'customer_created' });
    expect(delivery.status).toBe('failed');
    expect(delivery.crm[0]!.error).toContain('Column not found');
  });
});
