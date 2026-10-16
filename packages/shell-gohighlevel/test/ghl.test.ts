import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cryptoJsAesEncrypt, Router, runLifecycle, runSimulation, signState } from '@ccb/core-api';
import { createGoHighLevelShell, GHL_API_VERSION, GHL_TAGS, type GhlConfig } from '../src/index.js';
import { makeEngine, mockFetch, request } from '../../core-api/test/helpers.js';

const API = 'https://ghl.mock';

function setup(config: GhlConfig = {}) {
  const { engine } = makeEngine({ adapters: [] });
  const mock = mockFetch([
    { match: '/contacts/upsert', reply: { new: true, contact: { id: 'ghl_ct_1' } } },
    { match: '/oauth/token', reply: { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 86399, locationId: 'loc_1', companyId: 'co_1', userType: 'Location' } },
  ]);
  const shell = createGoHighLevelShell(
    { engine, publicUrl: 'https://bridge.test', fetchImpl: mock.fetch, appSecret: 'app-secret' },
    { apiBase: API, privateToken: 'pit_123', defaultLocationId: 'loc_1', ...config },
  );
  engine.addAdapter(shell.adapter);
  const router = new Router();
  shell.registerRoutes(router);
  return { engine, shell, router, mock };
}

describe('GoHighLevel shell', () => {
  it('upserts the unified contact with E.164 phone, FSM tags and LTV custom fields', async () => {
    const { engine, mock } = setup();
    await runSimulation(engine, { source: 'housecallpro', scenario: 'customer_created', persona: 1 });
    const call = mock.calls.find((c) => c.path === '/contacts/upsert')!;
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer pit_123');
    expect(call.headers.version).toBe(GHL_API_VERSION);
    expect(call.body).toMatchObject({
      locationId: 'loc_1',
      firstName: 'Derek',
      phone: '+15125550187',
      email: 'derek.t@example.net',
      source: 'FSM · Facebook Ads',
      tags: ['fsm-housecallpro'],
    });
    expect((call.body as { customFields: Array<{ key: string }> }).customFields.map((f) => f.key)).toContain('fsm_lifetime_value');
  });

  it('every trigger adds the matching contact tag so stock "Tag Added" workflows fire', async () => {
    const { engine, mock } = setup();
    await runLifecycle(engine, { source: 'jobber', persona: 0 });
    const tags = mock.calls.filter((c) => c.path === '/contacts/ghl_ct_1/tags').map((c) => (c.body as { tags: string[] }).tags[0]);
    expect(tags).toEqual([
      GHL_TAGS.estimate_approved,
      GHL_TAGS.technician_dispatched,
      GHL_TAGS.job_completed,
      GHL_TAGS.invoice_paid,
      GHL_TAGS.invoice_paid_high_value,
      'review-request-ready',
    ]);
  });

  it('custom workflow trigger: subscribe → fire to targetUrl with flat fields → unsubscribe', async () => {
    const { engine, router, mock } = setup({ actionSecret: 'act' });
    const sub = await request(router, 'POST', '/ghl/triggers/subscribe?key=act', {
      body: { triggerData: { id: 'trg_1', key: 'review_request_ready', eventType: 'CREATED', targetUrl: 'https://hooks.ghl.mock/trg_1' }, extras: { locationId: 'loc_1', workflowId: 'wf_9' } },
    });
    expect(sub.status).toBe(200);
    await runLifecycle(engine, { source: 'servicetitan', persona: 2 });
    const fired = mock.calls.filter((c) => c.url === 'https://hooks.ghl.mock/trg_1');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.body).toMatchObject({ trigger: 'review_request_ready', contact_phone: '+17375550119', review_eligible: true, contactId: 'ghl_ct_1', locationId: 'loc_1' });

    await request(router, 'POST', '/ghl/triggers/subscribe?key=act', { body: { triggerData: { id: 'trg_1', key: 'review_request_ready', eventType: 'DELETED' } } });
    await runLifecycle(engine, { source: 'fieldedge', persona: 3 });
    expect(mock.calls.filter((c) => c.url === 'https://hooks.ghl.mock/trg_1')).toHaveLength(1);
  });

  it('trigger subscription and action endpoints require the action secret when configured', async () => {
    const { router } = setup({ actionSecret: 'act' });
    expect((await request(router, 'POST', '/ghl/triggers/subscribe', { body: {} })).status).toBe(401);
    expect((await request(router, 'POST', '/ghl/actions/lookup_customer_ltv?key=wrong', { body: {} })).status).toBe(401);
  });

  it('custom action fire_test_event runs the sandbox pipeline; lookup_customer_ltv returns unified LTV', async () => {
    const { router } = setup();
    const fired = await request(router, 'POST', '/ghl/actions/fire_test_event', { body: { data: { source: 'Housecall Pro', scenario: 'invoice_paid', amount: '650', persona: 1 } } });
    expect(fired.json).toMatchObject({ status: 'processed' });
    expect(fired.json.triggers_fired).toContain('invoice_paid_high_value');
    const ltv = await request(router, 'POST', '/ghl/actions/lookup_customer_ltv', { body: { data: { phone: '(512) 555-0187' } } });
    expect(ltv.json).toMatchObject({ found: true, lifetime_value: 650 });
    expect((await request(router, 'POST', '/ghl/actions/fire_test_event', { body: { data: { source: 'acculynx' } } })).status).toBe(400);
  });

  it('OAuth install redirects to the GHL location chooser; callback stores location tokens', async () => {
    const { router, shell, mock } = setup({ clientId: 'cid', clientSecret: 'csec', privateToken: undefined, defaultLocationId: undefined });
    const install = await request(router, 'GET', '/ghl/oauth/install');
    const loc = new URL(install.headers!.location!);
    expect(loc.pathname).toBe('/oauth/chooselocation');
    expect(loc.searchParams.get('scope')).toContain('contacts.write');
    const cb = await request(router, 'GET', `/ghl/oauth/callback?code=abc&state=${encodeURIComponent(signState('app-secret'))}`);
    expect(cb.status).toBe(200);
    const tokenCall = mock.calls.find((c) => c.path === '/oauth/token')!;
    expect(tokenCall.body).toMatchObject({ grant_type: 'authorization_code', code: 'abc', user_type: 'Location', client_id: 'cid' });
    expect(shell.vault.get('loc_1')).toMatchObject({ accessToken: 'at_1', refreshToken: 'rt_1' });
    expect((await request(router, 'GET', '/ghl/oauth/callback?code=abc&state=forged.sig')).status).toBe(400);
  });

  it('refreshes an expired location token before calling the API', async () => {
    const { engine, shell, mock } = setup({ clientId: 'cid', clientSecret: 'csec', privateToken: undefined, defaultLocationId: undefined });
    shell.vault.set('loc_1', { accessToken: 'stale', refreshToken: 'rt_old', expiresAt: Date.now() - 1000 });
    await runSimulation(engine, { source: 'jobber', scenario: 'customer_created' });
    expect(mock.calls.find((c) => c.path === '/oauth/token')?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt_old' });
    expect(mock.calls.find((c) => c.path === '/contacts/upsert')?.headers.authorization).toBe('Bearer at_1');
  });

  it('Custom Page SSO: decrypts the GHL payload and issues a page session that unlocks the page API', async () => {
    const { router } = setup({ ssoSharedSecret: 'sso-secret', adminToken: 'admin' });
    const page = await request(router, 'GET', '/ghl/custom-page');
    expect(String(page.body)).toContain('REQUEST_USER_DATA');
    expect(page.headers!['content-security-policy']).toContain('frame-ancestors');
    expect((await request(router, 'GET', '/ghl/page-api/overview')).status).toBe(401);
    const payload = cryptoJsAesEncrypt(JSON.stringify({ userId: 'u1', companyId: 'co_1', activeLocation: 'loc_1', role: 'admin', userName: 'Ann' }), 'sso-secret');
    const sso = await request(router, 'POST', '/ghl/sso', { body: { payload } });
    expect(sso.json.user).toMatchObject({ userId: 'u1', locationId: 'loc_1' });
    const test = await request(router, 'POST', '/ghl/page-api/test', { body: { source: 'jobber', scenario: 'job_completed' }, headers: { authorization: `Bearer ${sso.json.session}` } });
    expect(test.json.delivery.status).toBe('processed');
    const overview = await request(router, 'GET', '/ghl/page-api/overview', { headers: { authorization: `Bearer ${sso.json.session}` } });
    expect(overview.json.deliveries[0].ghl[0]).toMatchObject({ target: 'gohighlevel', action: 'contact.upsert', ok: true });
    expect((await request(router, 'POST', '/ghl/sso', { body: { payload: cryptoJsAesEncrypt('{}', 'other') } })).status).toBe(401);
  });

  it('app UNINSTALL webhook (RSA x-wh-signature) removes tokens and subscriptions', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { router, shell } = setup({ webhookPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateToken: undefined });
    shell.vault.set('loc_9', { accessToken: 'x' });
    const raw = JSON.stringify({ type: 'UNINSTALL', locationId: 'loc_9' });
    const sig = createSign('sha256').update(raw).sign(privateKey, 'base64');
    expect((await request(router, 'POST', '/ghl/webhooks/app', { raw, headers: { 'x-wh-signature': 'bad' } })).status).toBe(401);
    expect((await request(router, 'POST', '/ghl/webhooks/app', { raw, headers: { 'x-wh-signature': sig } })).status).toBe(200);
    expect(shell.vault.get('loc_9')).toBeUndefined();
  });

  it('manifest lists 6 triggers, 2 actions, the custom page and required scopes', () => {
    const { shell } = setup({ actionSecret: 'act' });
    const m = shell.manifest() as { triggers: unknown[]; actions: Array<{ executionUrl: string }>; customPage: { url: string }; scopes: string[] };
    expect(m.triggers).toHaveLength(6);
    expect(m.actions.map((a) => a.executionUrl)).toEqual(['https://bridge.test/ghl/actions/fire_test_event?key=<GHL_ACTION_SECRET>', 'https://bridge.test/ghl/actions/lookup_customer_ltv?key=<GHL_ACTION_SECRET>']);
    expect(m.customPage.url).toBe('https://bridge.test/ghl/custom-page');
    expect(m.scopes).toContain('contacts.write');
  });

  it('is not connected until a token exists', () => {
    const { shell } = setup({ privateToken: undefined, defaultLocationId: undefined });
    expect(shell.adapter.isConnected({ accountId: null, simulated: false, deliveryId: 'x' })).toBe(false);
  });
});
