import { describe, expect, it } from 'vitest';
import { createGateway, loadConfig } from '../src/index.js';
import { request } from '../../core-api/test/helpers.js';

describe('gateway config', () => {
  it('defaults: sandbox on, signatures required, $500 high-value threshold, ephemeral FSM secrets', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 8787, sandbox: true, requireSignatures: true, highValueThresholdCents: 50_000, adminToken: null, publicUrl: 'http://localhost:8787' });
    expect(c.fsm.jobber.generated).toBe(true);
    expect(c.fsm.jobber.webhookSecret.length).toBeGreaterThan(20);
  });

  it('reads FSM secrets, CRM credentials, review rules and maps from env', () => {
    const c = loadConfig({
      PORT: '9000',
      PUBLIC_URL: 'https://bridge.example.com/',
      HCP_WEBHOOK_SECRET: 'hcp',
      JOBBER_ACCESS_TOKEN: 'jat',
      REVIEW_COOLDOWN_DAYS: '30',
      REVIEW_ENABLED: 'false',
      GHL_LOCATION_MAP: '{"acct_1":"loc_1"}',
      GHL_WEBHOOK_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',
      MAKE_API_KEYS: 'a, b,,c',
      SANDBOX: 'false',
    });
    expect(c.publicUrl).toBe('https://bridge.example.com');
    expect(c.fsm.housecallpro).toMatchObject({ webhookSecret: 'hcp', generated: false });
    expect(c.fsm.jobber.accessToken).toBe('jat');
    expect(c.review).toMatchObject({ cooldownDays: 30, enabled: false });
    expect(c.ghl.locationMap).toEqual({ acct_1: 'loc_1' });
    expect(c.ghl.webhookPublicKey).toContain('\nabc\n');
    expect(c.make.apiKeys).toEqual(['a', 'b', 'c']);
    expect(c.sandbox).toBe(false);
  });

  it('rejects malformed numeric and JSON settings', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/expected a number/);
    expect(() => loadConfig({ GHL_LOCATION_MAP: '{nope' })).toThrow(/GHL_LOCATION_MAP/);
  });

  it('composes core + all five shells on one router with a manifest endpoint', async () => {
    const gw = createGateway(loadConfig({ ADMIN_TOKEN: 'adm', MAKE_API_KEYS: 'k' }));
    expect(gw.shells.map((s) => s.id)).toEqual(['gohighlevel', 'hubspot', 'pipedrive', 'monday', 'makecom']);
    expect(gw.engine.adapters.map((a) => a.id)).toEqual(['gohighlevel', 'hubspot', 'pipedrive', 'monday', 'makecom', 'sandbox']);
    const routes = gw.router.listRoutes();
    for (const r of ['POST /webhooks/:source', 'GET /playground', 'GET /ghl/custom-page', 'POST /hubspot/actions/:actionKey', 'GET /pipedrive/panel', 'POST /monday/triggers/:key/subscribe', 'POST /make/hooks']) {
      expect(routes).toContain(r);
    }
    expect((await request(gw.router, 'GET', '/api/manifests')).status).toBe(401);
    const m = await request(gw.router, 'GET', '/api/manifests', { headers: { authorization: 'Bearer adm' } });
    expect(Object.keys(m.json.crms)).toEqual(['gohighlevel', 'hubspot', 'pipedrive', 'monday', 'makecom']);
    expect(m.json.webhooks.jobber).toBe('http://localhost:8787/webhooks/jobber');
    const landing = await request(gw.router, 'GET', '/');
    expect(String(landing.body)).toContain('/webhooks/servicetitan');
  });

  it('restores persisted review settings over env defaults', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'ccb-gw-')), 'state.json');
    const gw = createGateway(loadConfig({ DATA_FILE: file }));
    await request(gw.router, 'PUT', '/api/settings/review', { body: { cooldownDays: 7, highValueThresholdCents: 25_000 } });
    gw.engine.store.flush();
    const again = createGateway(loadConfig({ DATA_FILE: file, REVIEW_COOLDOWN_DAYS: '90' }));
    expect(again.engine.reviewSettings.cooldownDays).toBe(7);
    expect(again.engine.highValueThresholdCents).toBe(25_000);
  });
});
