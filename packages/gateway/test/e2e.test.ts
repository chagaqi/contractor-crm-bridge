/**
 * End-to-end: build the single-file gateway (dist/server.mjs), run it as a real Node process, point
 * all five CRM integrations at a mock CRM HTTP server, and drive it purely over HTTP.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPayload } from '@ccb/core-api';
import { buildSimulatedWebhook } from '@ccb/core-api';

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, '..');
const bundle = resolve(gatewayDir, 'dist/server.mjs');

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

const seen: Seen[] = [];
const mockState = { failGhl: false };
let mock: Server;
let mockUrl = '';
let child: ChildProcess;
let base = '';
const ADMIN = 'e2e-admin';
const SECRETS = { JOBBER: 'jb-secret', HCP: 'hcp-secret', SERVICETITAN: 'st-secret', FIELDEDGE: 'fe-secret', BUILDERTREND: 'bt-secret' };

function mockReply(path: string, body: any): { status: number; body: unknown } {
  if (path.startsWith('/ghl/contacts/upsert')) return mockState.failGhl ? { status: 503, body: { message: 'Service Unavailable' } } : { status: 200, body: { new: true, contact: { id: 'ghl_1' } } };
  if (path === '/hs/crm/v3/objects/contacts/search') return { status: 200, body: { total: 0, results: [] } };
  if (path === '/hs/crm/v3/objects/contacts') return { status: 201, body: { id: 'hs_1' } };
  if (path === '/hs/crm/v3/objects/deals') return { status: 201, body: { id: 'deal_1' } };
  if (path === '/pd/v1/persons/search') return { status: 200, body: { data: { items: [] } } };
  if (path === '/pd/v1/persons') return { status: 201, body: { data: { id: 11 } } };
  if (path.startsWith('/monday')) {
    const q: string = body?.query ?? '';
    if (q.includes('items_page_by_column_values')) return { status: 200, body: { data: { items_page_by_column_values: { items: [] } } } };
    if (q.includes('create_item')) return { status: 200, body: { data: { create_item: { id: 'mon_1' } } } };
    return { status: 200, body: { data: { ok: true } } };
  }
  return { status: 200, body: { data: { id: 1 }, ok: true } };
}

async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${ADMIN}`, ...((init.headers as Record<string, string>) ?? {}) };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text, headers: res.headers };
}

beforeAll(async () => {
  execFileSync(process.execPath, [resolve(gatewayDir, 'build.mjs')], { stdio: 'pipe' });

  mock = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* form or text */
      }
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
      const reply = mockReply(path, body);
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  child = spawn(process.execPath, [bundle], {
    env: {
      PATH: process.env.PATH,
      PORT: '0',
      HOST: '127.0.0.1',
      ADMIN_TOKEN: ADMIN,
      CRM_RETRY_BASE_DELAY_MS: '0',
      ...Object.fromEntries(Object.entries(SECRETS).map(([k, v]) => [`${k}_WEBHOOK_SECRET`, v])),
      GHL_PRIVATE_TOKEN: 'ghl_pit',
      GHL_LOCATION_ID: 'loc_e2e',
      GHL_API_BASE: `${mockUrl}/ghl`,
      HUBSPOT_PRIVATE_APP_TOKEN: 'hs_pat',
      HUBSPOT_API_BASE: `${mockUrl}/hs`,
      PIPEDRIVE_API_TOKEN: 'pd_tok',
      PIPEDRIVE_API_BASE: `${mockUrl}/pd`,
      MONDAY_API_TOKEN: 'mon_tok',
      MONDAY_BOARD_ID: '777',
      MONDAY_API_URL: `${mockUrl}/monday`,
      MAKE_API_KEYS: 'mk_e2e',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise<string>((resolveUrl, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`gateway did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on (http:\/\/[\d.]+:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]!);
      }
    });
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => reject(new Error(`gateway exited with ${code}: ${out}`)));
  });
}, 30_000);

afterAll(async () => {
  child?.kill('SIGTERM');
  await new Promise<void>((r) => mock?.close(() => r()));
});

describe('gateway dist/server.mjs (E2E)', () => {
  it('is a single self-contained ESM bundle with no external imports', () => {
    expect(existsSync(bundle)).toBe(true);
    const src = readFileSync(bundle, 'utf8');
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true);
    const imports = [...src.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]!);
    expect(imports.every((s) => s.startsWith('node:'))).toBe(true);
    expect(statSync(bundle).size).toBeLessThan(1_000_000);
  });

  it('serves /health, the landing page and the playground', async () => {
    const health = await api('/health');
    expect(health.json.ok).toBe(true);
    expect(health.json.crms.filter((c: { connected: boolean }) => c.connected).map((c: { id: string }) => c.id)).toEqual(['gohighlevel', 'hubspot', 'pipedrive', 'monday']);
    expect((await api('/')).text).toContain('Contractor CRM Bridge');
    expect((await api('/playground')).text).toContain('FSM Sandbox Simulator');
  });

  it('enforces ADMIN_TOKEN on the API', async () => {
    const res = await fetch(`${base}/api/deliveries`);
    expect(res.status).toBe(401);
  });

  it('real signed FSM webhooks over HTTP fan out to GoHighLevel, HubSpot, Pipedrive and monday.com', async () => {
    seen.length = 0;
    const secret = SECRETS.HCP;
    for (const scenario of ['estimate_approved', 'technician_dispatched', 'job_completed', 'invoice_paid'] as const) {
      const hook = buildSimulatedWebhook({ source: 'housecallpro', scenario, jobRef: 'e2e-job-1', persona: 0, amountCents: 65_000 }, secret);
      const res = await fetch(`${base}/webhooks/housecallpro`, { method: 'POST', headers: hook.headers, body: hook.rawBody });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('processed');
    }
    const ghl = seen.filter((s) => s.path.startsWith('/ghl/'));
    expect(ghl[0]).toMatchObject({ method: 'POST', path: '/ghl/contacts/upsert' });
    expect(ghl[0]!.headers.authorization).toBe('Bearer ghl_pit');
    expect(ghl[0]!.body).toMatchObject({ locationId: 'loc_e2e', phone: '+15125550142' });
    expect(ghl.filter((s) => s.path === '/ghl/contacts/ghl_1/tags').map((s) => s.body.tags[0])).toContain('review-request-ready');

    expect(seen.some((s) => s.path === '/hs/crm/v3/objects/contacts' && s.method === 'POST')).toBe(true);
    expect(seen.some((s) => s.path === '/hs/crm/v3/objects/deals')).toBe(true);
    expect(seen.some((s) => s.path === '/pd/v1/persons' && s.method === 'POST')).toBe(true);
    expect(seen.some((s) => s.path === '/pd/v1/activities' && /review/.test(s.body.subject))).toBe(true);
    expect(seen.some((s) => s.path === '/monday' && String(s.body.query).includes('create_item'))).toBe(true);

    const deliveries = await api('/api/deliveries?source=housecallpro');
    const last = deliveries.json.deliveries[0];
    expect(last.triggers.filter((t: { key: string; fired: boolean }) => t.key === 'review_request_ready' && t.fired).map((t: { key: string }) => t.key)).toHaveLength(4);
    const targets = new Set(last.crm.map((c: { target: string }) => c.target));
    expect([...targets].sort()).toEqual(['gohighlevel', 'hubspot', 'monday', 'pipedrive']);
  });

  it('rejects a tampered webhook with 401 and records the rejection in the delivery log', async () => {
    const hook = buildSimulatedWebhook({ source: 'jobber', scenario: 'job_completed' }, SECRETS.JOBBER);
    const res = await fetch(`${base}/webhooks/jobber`, { method: 'POST', headers: hook.headers, body: hook.rawBody.replace('JOB_COMPLETE', 'JOB_UPDATE') });
    expect(res.status).toBe(401);
    const rejected = await api('/api/deliveries?status=rejected');
    expect(rejected.json.deliveries[0].error).toBe('invalid signature: signature mismatch');
  });

  it('a CRM outage is retried, logged as partial with the HTTP status, then fixed by replay', async () => {
    mockState.failGhl = true;
    const raw = JSON.stringify({ EventId: 'fe-outage-1', EventType: 'Customer.Created', CompanyId: 'c', Data: { CustomerId: 'C-OUT', FirstName: 'Out', LastName: 'Age', Phones: [{ Number: '512-555-0177', Type: 'Mobile' }] } });
    const res = await fetch(`${base}/webhooks/fieldedge`, { method: 'POST', headers: { 'content-type': 'application/json', ...signPayload('fieldedge', SECRETS.FIELDEDGE, raw) }, body: raw });
    const out = await res.json();
    expect(out.status).toBe('partial');
    const detail = await api(`/api/deliveries/${out.delivery}`);
    const ghlCall = detail.json.crm.find((c: { target: string }) => c.target === 'gohighlevel');
    expect(ghlCall).toMatchObject({ ok: false, status: 503, attempts: 3 });
    expect(seen.filter((s) => s.path === '/ghl/contacts/upsert' && s.body?.phone === '+15125550177')).toHaveLength(3);

    mockState.failGhl = false;
    const replay = await api(`/api/deliveries/${out.delivery}/replay`, { method: 'POST' });
    expect(replay.json).toMatchObject({ status: 'processed', replayOf: out.delivery });
  });

  it('sandbox simulator + Make instant trigger + GHL custom page API work over HTTP', async () => {
    const hook = await fetch(`${base}/make/hooks`, {
      method: 'POST',
      headers: { authorization: 'Bearer mk_e2e', 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${mockUrl}/make-hook`, trigger: 'invoice_paid_high_value' }),
    });
    expect(hook.status).toBe(201);
    const sim = await api('/api/simulate', { method: 'POST', json: { source: 'servicetitan', scenario: 'invoice_paid', amountCents: 120_000, persona: 2 } });
    expect(sim.json.delivery.status).toBe('processed');
    const makeCall = seen.find((s) => s.path === '/make-hook');
    expect(makeCall?.body).toMatchObject({ trigger: 'invoice_paid_high_value', invoice_total: 1200, fsm_source: 'servicetitan' });

    const page = await api('/ghl/page-api/overview');
    expect(page.json.revenue.totalRevenueCents).toBeGreaterThanOrEqual(185_000);
    expect(page.json.deliveries.length).toBeGreaterThan(0);
    const inbox = await api('/api/sandbox/inbox');
    expect(inbox.json.entries[0].key).toBe('invoice_paid_high_value');
  });

  it('streams deliveries over SSE', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?token=${ADMIN}`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const fire = api('/api/simulate', { method: 'POST', json: { source: 'buildertrend', scenario: 'technician_dispatched' } });
    while (!buf.includes('event: delivery')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    await fire;
    ctrl.abort();
    expect(buf).toContain('event: ready');
    expect(buf).toContain('"job.dispatched"');
  });
});
