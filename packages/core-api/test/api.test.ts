import { describe, expect, it } from 'vitest';
import { buildSimulatedWebhook, registerCoreRoutes, Router } from '../src/index.js';
import { makeEngine, request, SECRET } from './helpers.js';

function setup(opts: { adminToken?: string; sandbox?: boolean } = {}) {
  const { engine, recorder } = makeEngine();
  const router = new Router();
  registerCoreRoutes(router, engine, { adminToken: opts.adminToken, sandbox: opts.sandbox, publicUrl: 'https://bridge.test' });
  return { engine, recorder, router };
}

describe('core HTTP API', () => {
  it('GET /health lists FSM secrets and CRM adapters', async () => {
    const { router } = setup();
    const res = await request(router, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.json.sources).toHaveLength(5);
    expect(res.json.crms.map((c: { id: string }) => c.id)).toContain('recorder');
  });

  it('POST /webhooks/:source → 200 processed for a correctly signed webhook', async () => {
    const { router } = setup();
    const hook = buildSimulatedWebhook({ source: 'servicetitan', scenario: 'job_completed' }, SECRET);
    const res = await request(router, 'POST', '/webhooks/servicetitan', { raw: hook.rawBody, headers: hook.headers });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'processed', events: ['job.completed'] });
  });

  it('POST /webhooks/:source → 401 on a bad signature, 404 on an unknown FSM', async () => {
    const { router } = setup();
    const hook = buildSimulatedWebhook({ source: 'fieldedge', scenario: 'job_completed' }, 'wrong');
    expect((await request(router, 'POST', '/webhooks/fieldedge', { raw: hook.rawBody, headers: hook.headers })).status).toBe(401);
    expect((await request(router, 'POST', '/webhooks/acculynx', { raw: '{}' })).status).toBe(404);
  });

  it('GET /playground serves the simulator UI', async () => {
    const { router } = setup();
    const res = await request(router, 'GET', '/playground');
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toMatch(/text\/html/);
    expect(String(res.body)).toContain('FSM Sandbox Simulator');
    expect(String(res.body)).toContain('Technician Dispatched');
  });

  it('POST /api/simulate fires through the pipeline and the sandbox inbox records the payloads', async () => {
    const { router } = setup();
    const res = await request(router, 'POST', '/api/simulate', { body: { source: 'jobber', scenario: 'estimate_approved', amountCents: 125000 } });
    expect(res.status).toBe(200);
    expect(res.json.delivery.status).toBe('processed');
    expect(res.json.webhook.headers['x-jobber-hmac-sha256']).toBeTruthy();
    const inbox = await request(router, 'GET', '/api/sandbox/inbox');
    expect(inbox.json.entries.map((e: { key: string }) => e.key)).toEqual(['estimate_approved', 'contact.upsert']);
    expect(inbox.json.entries[0].fields.estimate_total).toBe(1250);
  });

  it('POST /api/simulate validates input', async () => {
    const { router } = setup();
    expect((await request(router, 'POST', '/api/simulate', { body: { source: 'nope', scenario: 'job_completed' } })).status).toBe(400);
    expect((await request(router, 'POST', '/api/simulate', { body: { source: 'jobber', scenario: 'nope' } })).status).toBe(400);
    expect((await request(router, 'POST', '/api/simulate', { body: { source: 'jobber', scenario: 'invoice_paid', amountCents: -5 } })).status).toBe(400);
    expect((await request(router, 'POST', '/api/simulate', { raw: '{bad' })).status).toBe(400);
  });

  it('lifecycle → deliveries, contacts, revenue and contact detail endpoints agree', async () => {
    const { router } = setup();
    const life = await request(router, 'POST', '/api/simulate/lifecycle', { body: { source: 'housecallpro', persona: 2, amountCents: 80000 } });
    expect(life.json.deliveries).toHaveLength(4);
    const deliveries = await request(router, 'GET', '/api/deliveries?source=housecallpro&status=processed');
    expect(deliveries.json.deliveries).toHaveLength(4);
    expect(deliveries.json.stats.byStatus.processed).toBe(4);
    const contacts = await request(router, 'GET', '/api/contacts?q=praman');
    expect(contacts.json.contacts).toHaveLength(1);
    expect(contacts.json.contacts[0].metrics.lifetimeValueCents).toBe(80000);
    const detail = await request(router, 'GET', `/api/contacts/${contacts.json.contacts[0].id}`);
    expect(detail.json.deliveries).toHaveLength(4);
    const revenue = await request(router, 'GET', '/api/revenue');
    expect(revenue.json.byLeadSource[0]).toMatchObject({ key: 'Referral', revenueCents: 80000 });
    const one = await request(router, 'GET', `/api/deliveries/${life.json.deliveries[3].id}`);
    expect(one.json.triggers.map((t: { key: string }) => t.key)).toContain('review_request_ready');
  });

  it('PUT /api/settings/review updates rules and validates them', async () => {
    const { router, engine } = setup();
    const res = await request(router, 'PUT', '/api/settings/review', { body: { cooldownDays: 30, highValueThresholdCents: 100000, channels: ['sms', 'fax'] } });
    expect(res.status).toBe(200);
    expect(engine.reviewSettings.cooldownDays).toBe(30);
    expect(engine.reviewSettings.channels).toEqual(['sms']);
    expect(engine.highValueThresholdCents).toBe(100000);
    expect((await request(router, 'PUT', '/api/settings/review', { body: { cooldownDays: -1 } })).status).toBe(400);
  });

  it('POST /api/deliveries/:id/replay re-runs a delivery; unknown ids → 409', async () => {
    const { router } = setup();
    const sim = await request(router, 'POST', '/api/simulate', { body: { source: 'fieldedge', scenario: 'customer_created' } });
    const replay = await request(router, 'POST', `/api/deliveries/${sim.json.delivery.id}/replay`);
    expect(replay.json).toMatchObject({ replayOf: sim.json.delivery.id, status: 'processed' });
    expect((await request(router, 'POST', '/api/deliveries/dlv_missing/replay')).status).toBe(409);
  });

  it('ADMIN_TOKEN protects /api/* (Bearer or ?token=) but not FSM webhooks', async () => {
    const { router } = setup({ adminToken: 'admintok' });
    expect((await request(router, 'GET', '/api/deliveries')).status).toBe(401);
    expect((await request(router, 'GET', '/api/deliveries', { headers: { authorization: 'Bearer admintok' } })).status).toBe(200);
    expect((await request(router, 'GET', '/api/deliveries?token=admintok')).status).toBe(200);
    expect((await request(router, 'GET', '/api/deliveries', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const hook = buildSimulatedWebhook({ source: 'buildertrend', scenario: 'job_completed' }, SECRET);
    expect((await request(router, 'POST', '/webhooks/buildertrend', { raw: hook.rawBody, headers: hook.headers })).status).toBe(200);
  });

  it('sandbox=false removes the simulator surface', async () => {
    const { router } = setup({ sandbox: false });
    expect((await request(router, 'GET', '/playground')).status).toBe(404);
    expect((await request(router, 'POST', '/api/simulate', { body: {} })).status).toBe(404);
  });

  it('GET /api/stream is a server-sent-event stream', async () => {
    const { router, engine } = setup();
    const res = await request(router, 'GET', '/api/stream');
    expect(res.headers?.['content-type']).toBe('text/event-stream');
    const chunks: string[] = [];
    let close = () => {};
    res.stream!({ write: (c) => chunks.push(c), onClose: (fn) => (close = fn) });
    await request(router, 'POST', '/api/simulate', { body: { source: 'jobber', scenario: 'customer_created' } });
    close();
    expect(chunks[0]).toContain('event: ready');
    expect(chunks.some((c) => c.startsWith('event: delivery'))).toBe(true);
    void engine;
  });

  it('router answers 404 / 405 correctly', async () => {
    const { router } = setup();
    expect((await request(router, 'GET', '/nope')).status).toBe(404);
    expect((await request(router, 'DELETE', '/health')).status).toBe(405);
  });
});
