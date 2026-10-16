import { describe, expect, it } from 'vitest';
import { basicAuth, Router, runLifecycle, runSimulation, signState } from '@ccb/core-api';
import { createPipedriveShell, type PipedriveConfig } from '../src/index.js';
import { makeEngine, mockFetch, request } from '../../core-api/test/helpers.js';

function setup(config: PipedriveConfig = {}, existingPersonId: number | null = null) {
  const { engine } = makeEngine({ adapters: [] });
  const mock = mockFetch([
    { match: '/v1/persons/search', reply: { data: { items: existingPersonId ? [{ item: { id: existingPersonId } }] : [] } } },
    { method: 'POST', match: '/v1/persons', status: 201, reply: { data: { id: 77 } } },
    { method: 'GET', match: '/v1/persons/77', reply: { data: { id: 77, email: [{ value: 'derek.t@example.net' }], phone: [{ value: '+15125550187' }] } } },
    { method: 'POST', match: '/v1/deals', status: 201, reply: { data: { id: 5 } } },
    { match: '/oauth/token', reply: { access_token: 'pd_at', refresh_token: 'pd_rt', expires_in: 3599, api_domain: 'https://acme.pipedrive.com', scope: 'base' } },
  ]);
  const shell = createPipedriveShell({ engine, publicUrl: 'https://bridge.test', fetchImpl: mock.fetch, appSecret: 'app' }, { apiToken: 'pd_token', apiBase: 'https://pd.mock', ...config });
  engine.addAdapter(shell.adapter);
  const router = new Router();
  shell.registerRoutes(router);
  return { engine, shell, router, mock };
}

describe('Pipedrive shell', () => {
  it('searches persons by email then phone (exact), then creates with labelled E.164 phones', async () => {
    const { engine, mock } = setup({ fieldKeys: { ltv: 'abc123ltv' } });
    await runSimulation(engine, { source: 'housecallpro', scenario: 'customer_created', persona: 1 });
    const searches = mock.calls.filter((c) => c.path === '/v1/persons/search').map((c) => new URL(c.url).searchParams);
    expect(searches.map((s) => [s.get('fields'), s.get('term'), s.get('exact_match')])).toEqual([
      ['email', 'derek.t@example.net', 'true'],
      ['phone', '+15125550187', 'true'],
    ]);
    expect(new URL(mock.calls[0]!.url).searchParams.get('api_token')).toBe('pd_token');
    const create = mock.calls.find((c) => c.method === 'POST' && c.path === '/v1/persons')!;
    expect(create.body).toMatchObject({ name: 'Derek Thompson', phone: [{ value: '+15125550187', primary: true, label: 'mobile' }], abc123ltv: 0 });
  });

  it('updates an existing person instead of duplicating', async () => {
    const { engine, mock } = setup({}, 31);
    await runSimulation(engine, { source: 'jobber', scenario: 'customer_created' });
    expect(mock.calls.some((c) => c.method === 'PUT' && c.path === '/v1/persons/31')).toBe(true);
  });

  it('maps triggers to won deals, activities and notes', async () => {
    const { engine, mock } = setup();
    await runLifecycle(engine, { source: 'servicetitan', persona: 1, amountCents: 65_000 });
    const deal = mock.calls.find((c) => c.path === '/v1/deals')!;
    expect(deal.body).toMatchObject({ status: 'won', person_id: 77, value: 650, currency: 'USD' });
    const activities = mock.calls.filter((c) => c.path === '/v1/activities').map((c) => c.body as { subject: string; type: string });
    expect(activities[0]!.subject).toMatch(/^Technician dispatched: /);
    expect(activities[1]).toMatchObject({ type: 'task', subject: 'Send Google review request (sms + email)' });
    expect(mock.calls.filter((c) => c.path === '/v1/notes')).toHaveLength(3); // job_completed, invoice_paid, invoice_paid_high_value
  });

  it('JSON panel returns LTV for the selected person and enforces basic auth', async () => {
    const { engine, router } = setup({ panelUser: 'pd', panelPassword: 'pw' });
    await runLifecycle(engine, { source: 'housecallpro', persona: 1 });
    expect((await request(router, 'GET', '/pipedrive/panel?resource=person&selectedIds=77')).status).toBe(401);
    const res = await request(router, 'GET', '/pipedrive/panel?resource=person&selectedIds=77', { headers: { authorization: basicAuth('pd', 'pw') } });
    expect(res.json.data[0]).toMatchObject({ lifetime_value: { code: 'USD', value: 650 }, completed_jobs: 1 });
  });

  it('OAuth: Basic client auth on the token exchange, api_domain stored for API calls', async () => {
    const { router, shell, mock, engine } = setup({ clientId: 'cid', clientSecret: 'cs', apiToken: undefined, apiBase: undefined, oauthBase: 'https://oauth.pd.mock' });
    const res = await request(router, 'GET', `/pipedrive/oauth/callback?code=c&state=${encodeURIComponent(signState('app'))}`);
    expect(res.status).toBe(200);
    const token = mock.calls.find((c) => c.path === '/oauth/token')!;
    expect(token.headers.authorization).toBe(basicAuth('cid', 'cs'));
    expect(shell.vault.get('acme')).toMatchObject({ accessToken: 'pd_at', meta: { apiDomain: 'https://acme.pipedrive.com/api' } });
    await runSimulation(engine, { source: 'jobber', scenario: 'customer_created' });
    const search = mock.calls.find((c) => c.path === '/api/v1/persons/search')!;
    expect(search.url.startsWith('https://acme.pipedrive.com/api/v1/')).toBe(true);
    expect(search.headers.authorization).toBe('Bearer pd_at');
  });

  it('fire_test_event action and lookup action', async () => {
    const { router } = setup();
    const fired = await request(router, 'POST', '/pipedrive/actions/fire_test_event', { body: { source: 'fieldedge', scenario: 'invoice_paid', persona: 0 } });
    expect(fired.json).toMatchObject({ success: true, data: { status: 'processed' } });
    const lookup = await request(router, 'GET', '/pipedrive/actions/lookup?email=maria.gonzalez@example.com');
    expect(lookup.json.data).toMatchObject({ found: true });
  });
});
