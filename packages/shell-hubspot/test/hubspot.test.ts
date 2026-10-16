import { describe, expect, it } from 'vitest';
import { Router, runLifecycle, runSimulation, signState } from '@ccb/core-api';
import { createHubSpotShell, HUBSPOT_PROPERTIES, hubspotSignatureV3, type HubSpotConfig } from '../src/index.js';
import { makeEngine, mockFetch, request } from '../../core-api/test/helpers.js';

const API = 'https://hs.mock';

function setup(config: HubSpotConfig = {}, searchResults: Array<{ id: string }> = []) {
  const { engine } = makeEngine({ adapters: [] });
  let nextId = 500;
  const mock = mockFetch([
    { method: 'POST', match: '/crm/v3/objects/contacts/search', reply: { total: searchResults.length, results: searchResults } },
    { method: 'POST', match: /\/crm\/v3\/objects\/contacts$/, status: 201, reply: () => ({ id: String(nextId++) }) },
    { method: 'POST', match: '/crm/v3/objects/deals', status: 201, reply: { id: 'deal_1' } },
    { match: '/oauth/v1/token', reply: { access_token: 'hs_at', refresh_token: 'hs_rt', expires_in: 1800 } },
    { match: '/oauth/v1/access-tokens/', reply: { hub_id: 4242, hub_domain: 'acme.hubspot.com' } },
  ]);
  const shell = createHubSpotShell({ engine, publicUrl: 'https://bridge.test', fetchImpl: mock.fetch, appSecret: 'app' }, { apiBase: API, privateAppToken: 'pat', ...config });
  engine.addAdapter(shell.adapter);
  const router = new Router();
  shell.registerRoutes(router);
  return { engine, shell, router, mock };
}

function signed(clientSecret: string, method: string, url: string, body = '') {
  const ts = String(Date.now());
  return { 'x-hubspot-signature-v3': hubspotSignatureV3({ clientSecret, method, url, body, timestamp: ts }), 'x-hubspot-request-timestamp': ts };
}

describe('HubSpot shell', () => {
  it('searches by fsm_bridge_id OR email OR phone, then creates the contact with FSM properties', async () => {
    const { engine, mock } = setup();
    await runSimulation(engine, { source: 'servicetitan', scenario: 'customer_created', persona: 2 });
    const search = mock.calls.find((c) => c.path.endsWith('/search'))!;
    expect(search.headers.authorization).toBe('Bearer pat');
    const groups = (search.body as { filterGroups: Array<{ filters: Array<{ propertyName: string; value: string }> }> }).filterGroups;
    expect(groups.map((g) => g.filters[0]!.propertyName)).toEqual(['fsm_bridge_id', 'email', 'phone']);
    expect(groups[2]!.filters[0]!.value).toBe('+17375550119');
    const create = mock.calls.find((c) => c.method === 'POST' && c.path === '/crm/v3/objects/contacts')!;
    expect((create.body as { properties: Record<string, string> }).properties).toMatchObject({ firstname: 'Priya', email: 'praman@example.org', phone: '+17375550119', fsm_sources: 'servicetitan', fsm_lead_source: 'Referral' });
  });

  it('updates (PATCH) an existing HubSpot contact found by search instead of duplicating', async () => {
    const { engine, mock } = setup({}, [{ id: '901' }]);
    await runSimulation(engine, { source: 'jobber', scenario: 'customer_created' });
    expect(mock.calls.some((c) => c.method === 'PATCH' && c.path === '/crm/v3/objects/contacts/901')).toBe(true);
    expect(mock.calls.some((c) => c.method === 'POST' && c.path === '/crm/v3/objects/contacts')).toBe(false);
  });

  it('lifecycle → won deal associated to the contact + fsm_last_trigger property updates for workflow enrollment', async () => {
    const { engine, mock } = setup({ timelineTemplates: { review_request_ready: 'tpl_1' } });
    await runLifecycle(engine, { source: 'housecallpro', persona: 0 });
    const deal = mock.calls.find((c) => c.path === '/crm/v3/objects/deals')!;
    expect(deal.body).toMatchObject({
      properties: { amount: '1250', dealstage: 'closedwon' },
      associations: [{ to: { id: '500' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
    });
    const triggers = mock.calls
      .filter((c) => c.method === 'PATCH' && (c.body as { properties: Record<string, string> }).properties.fsm_last_trigger)
      .map((c) => (c.body as { properties: Record<string, string> }).properties.fsm_last_trigger);
    expect(triggers).toEqual(['estimate_approved', 'technician_dispatched', 'job_completed', 'invoice_paid', 'invoice_paid_high_value', 'review_request_ready']);
    const timeline = mock.calls.find((c) => c.path === '/integrators/timeline/v3/events')!;
    expect(timeline.body).toMatchObject({ eventTemplateId: 'tpl_1', objectId: '500' });
  });

  it('workflow custom action verifies X-HubSpot-Signature-v3', async () => {
    const { router } = setup({ clientSecret: 'hs_secret' });
    const url = 'http://localhost/hubspot/actions/get_fsm_ltv';
    const raw = JSON.stringify({ inputFields: { phone: '(512) 555-0142' }, object: { objectId: 1 } });
    expect((await request(router, 'POST', '/hubspot/actions/get_fsm_ltv', { raw })).status).toBe(401);
    expect((await request(router, 'POST', '/hubspot/actions/get_fsm_ltv', { raw, headers: signed('wrong', 'POST', url, raw) })).status).toBe(401);
    const ok = await request(router, 'POST', '/hubspot/actions/get_fsm_ltv', { raw, headers: signed('hs_secret', 'POST', url, raw) });
    expect(ok.json).toEqual({ outputFields: { lifetime_value: 0, completed_jobs: 0, average_ticket: 0 } });
  });

  it('fire_test_event action returns HubSpot outputFields', async () => {
    const { router } = setup();
    const res = await request(router, 'POST', '/hubspot/actions/fire_test_event', { body: { inputFields: { source: 'buildertrend', scenario: 'estimate_approved', amount: 48250 } } });
    expect(res.json.outputFields).toMatchObject({ status: 'processed', triggers_fired: 'estimate_approved' });
  });

  it('CRM card shows unified LTV and recent jobs for the contact', async () => {
    const { engine, router } = setup();
    await runLifecycle(engine, { source: 'fieldedge', persona: 4 });
    const res = await request(router, 'GET', '/hubspot/crm-card?email=aisha.bello@example.com');
    expect(res.json.results[0].title).toContain('Aisha Bello');
    expect(res.json.results[0].properties[0]).toMatchObject({ label: 'Lifetime value', value: '650.00', dataType: 'CURRENCY' });
    expect(res.json.results[1].properties[0]).toMatchObject({ label: 'Status', value: 'completed', optionType: 'SUCCESS' });
    expect((await request(router, 'GET', '/hubspot/crm-card?email=nobody@example.com')).json.results).toEqual([]);
  });

  it('OAuth callback validates state, exchanges the code and resolves the portal id', async () => {
    const { router, shell, mock } = setup({ clientId: 'cid', clientSecret: 'cs', privateAppToken: undefined });
    expect((await request(router, 'GET', '/hubspot/oauth/callback?code=c1&state=bad')).status).toBe(400);
    const res = await request(router, 'GET', `/hubspot/oauth/callback?code=c1&state=${encodeURIComponent(signState('app'))}`);
    expect(res.status).toBe(200);
    expect(mock.calls.find((c) => c.path === '/oauth/v1/token')?.body).toMatchObject({ grant_type: 'authorization_code', code: 'c1', redirect_uri: 'https://bridge.test/hubspot/oauth/callback' });
    expect(shell.vault.get('4242')).toMatchObject({ accessToken: 'hs_at', meta: { portalId: '4242' } });
  });

  it('setup route creates the property group and every FSM property', async () => {
    const { router, mock } = setup();
    const res = await request(router, 'POST', '/hubspot/setup/properties');
    expect(res.json.results).toHaveLength(HUBSPOT_PROPERTIES.length + 1);
    expect(mock.calls.filter((c) => c.path === '/crm/v3/properties/contacts')).toHaveLength(HUBSPOT_PROPERTIES.length);
  });

  it('manifest exposes CRM card, workflow action definitions and scopes', () => {
    const { shell } = setup();
    const m = shell.manifest() as { workflowActions: Array<{ actionUrl: string; objectTypes: string[] }>; scopes: string[] };
    expect(m.workflowActions.map((a) => a.actionUrl)).toEqual(['https://bridge.test/hubspot/actions/fire_test_event', 'https://bridge.test/hubspot/actions/get_fsm_ltv']);
    expect(m.scopes).toContain('crm.objects.contacts.write');
  });
});
