import { describe, expect, it } from 'vitest';
import { Router, runLifecycle, runSimulation, TRIGGER_KEYS } from '@ccb/core-api';
import { createMakeShell, makeAppDefinition } from '../src/index.js';
import { makeEngine, mockFetch, request } from '../../core-api/test/helpers.js';

function setup() {
  const { engine } = makeEngine({ adapters: [] });
  const mock = mockFetch([{ match: 'hook.make.mock', reply: 'Accepted' }]);
  const shell = createMakeShell({ engine, publicUrl: 'https://bridge.test', fetchImpl: mock.fetch, appSecret: 'app' }, { apiKeys: ['mk_live_1'] });
  engine.addAdapter(shell.adapter);
  const router = new Router();
  shell.registerRoutes(router);
  const auth = { authorization: 'Bearer mk_live_1' };
  return { engine, shell, router, mock, auth };
}

describe('Make shell', () => {
  it('requires a configured API key on every /make route', async () => {
    const { router } = setup();
    expect((await request(router, 'GET', '/make/me')).status).toBe(401);
    expect((await request(router, 'GET', '/make/me', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await request(router, 'GET', '/make/me?api_key=mk_live_1')).status).toBe(200);
  });

  it('attach → instant trigger receives the flat field map → detach stops delivery', async () => {
    const { engine, router, mock, auth } = setup();
    const hook = await request(router, 'POST', '/make/hooks', { body: { url: 'https://hook.make.mock/abc', trigger: 'invoice_paid_high_value' }, headers: auth });
    expect(hook.status).toBe(201);
    await runSimulation(engine, { source: 'servicetitan', scenario: 'invoice_paid', amountCents: 72_500 });
    const sent = mock.calls.filter((c) => c.url === 'https://hook.make.mock/abc');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ trigger: 'invoice_paid_high_value', invoice_total: 725, fsm_source: 'servicetitan' });
    await request(router, 'DELETE', `/make/hooks/${hook.json.id}`, { headers: auth });
    await runSimulation(engine, { source: 'servicetitan', scenario: 'invoice_paid', amountCents: 72_500 });
    expect(mock.calls.filter((c) => c.url === 'https://hook.make.mock/abc')).toHaveLength(1);
  });

  it('an "all" hook receives every trigger; contact_synced hooks receive contact snapshots', async () => {
    const { engine, router, mock, auth } = setup();
    await request(router, 'POST', '/make/hooks', { body: { url: 'https://hook.make.mock/all', trigger: 'all' }, headers: auth });
    await request(router, 'POST', '/make/hooks', { body: { url: 'https://hook.make.mock/contacts', trigger: 'contact_synced' }, headers: auth });
    await runLifecycle(engine, { source: 'jobber' });
    expect(mock.calls.filter((c) => c.url.endsWith('/all')).map((c) => (c.body as { trigger: string }).trigger)).toEqual([...TRIGGER_KEYS]);
    expect(mock.calls.filter((c) => c.url.endsWith('/contacts'))).toHaveLength(4);
  });

  it('validates hook registration input', async () => {
    const { router, auth } = setup();
    expect((await request(router, 'POST', '/make/hooks', { body: { url: 'ftp://x' }, headers: auth })).status).toBe(400);
    expect((await request(router, 'POST', '/make/hooks', { body: { url: 'https://x', trigger: 'nope' }, headers: auth })).status).toBe(400);
  });

  it('search, get, simulate and failed-delivery endpoints back the Make modules', async () => {
    const { router, auth } = setup();
    const sim = await request(router, 'POST', '/make/simulate', { body: { source: 'housecallpro', scenario: 'invoice_paid', persona: 0 }, headers: auth });
    expect(sim.json).toMatchObject({ status: 'processed' });
    const search = await request(router, 'GET', '/make/customers?phone=5125550142', { headers: auth });
    expect(search.json.customers).toHaveLength(1);
    const get = await request(router, 'GET', `/make/customers/${search.json.customers[0].contact_id}`, { headers: auth });
    expect(get.json.invoices).toHaveLength(1);
    expect((await request(router, 'GET', '/make/deliveries?status=failed', { headers: auth })).json.deliveries).toEqual([]);
  });

  it('app definition wires dedicated webhooks with attach/detach and an instant trigger per FSM trigger', () => {
    const def = makeAppDefinition('https://bridge.test/');
    expect(def.base.baseUrl).toBe('https://bridge.test');
    expect(def.webhooks).toHaveLength(TRIGGER_KEYS.length);
    expect(def.webhooks[0]!.attach).toMatchObject({ url: '/make/hooks', method: 'POST', body: { url: '{{webhook.url}}' } });
    const triggers = def.modules.filter((m) => m.type === 'instant_trigger');
    expect(triggers).toHaveLength(TRIGGER_KEYS.length);
    expect(def.modules.map((m) => m.name)).toEqual(expect.arrayContaining(['fire_test_event', 'search_customers', 'get_customer', 'list_failed_deliveries']));
  });
});
