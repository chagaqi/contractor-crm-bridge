/**
 * Core HTTP surface: FSM webhook receivers, delivery logs, contacts/LTV, revenue attribution,
 * review-gate settings, and the FSM Sandbox Simulator (`GET /playground`).
 */
import { SandboxInboxAdapter } from './crm.js';
import { deliveryStats, filterDeliveries, type DeliveryStatus } from './delivery-log.js';
import type { BridgeEngine } from './engine.js';
import { header, html, HttpError, json, parseJson, safeCompare, type BridgeRequest, type Router } from './http.js';
import { renderPlayground } from './playground.js';
import type { ReviewGateSettings } from './review-gate.js';
import { LIFECYCLE, PERSONAS, runLifecycle, runSimulation, SCENARIO_LABELS, SCENARIOS, type Scenario } from './simulator.js';
import { FSM_SOURCES, isFsmSource, TRIGGER_KEYS, type FsmSource } from './types.js';

export interface CoreRoutesOptions {
  /** When set, `/api/*` requires `Authorization: Bearer <token>` or `?token=`. */
  adminToken?: string | null;
  /** Expose the simulator (`/playground`, `/api/simulate*`). Default true. */
  sandbox?: boolean;
  /** Base URL used to render webhook URLs in the UI. */
  publicUrl?: string;
  version?: string;
}

export function tokenFrom(req: BridgeRequest): string | null {
  const auth = header(req, 'authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return header(req, 'x-bridge-token') ?? req.query.get('token');
}

export function requireToken(token: string | null | undefined) {
  return (req: BridgeRequest) => {
    if (!token) return null;
    const provided = tokenFrom(req);
    if (provided && safeCompare(provided, token)) return null;
    return json(401, { error: 'unauthorized: provide the admin token as a Bearer token or ?token=' });
  };
}

function sourceParam(req: BridgeRequest): FsmSource {
  const source = req.params.source;
  if (!isFsmSource(source)) throw new HttpError(404, `unknown FSM source "${source}". Expected one of ${FSM_SOURCES.join(', ')}`);
  return source;
}

export function registerCoreRoutes(router: Router, engine: BridgeEngine, options: CoreRoutesOptions = {}): void {
  const sandbox = options.sandbox ?? true;
  router.guard('/api', requireToken(options.adminToken));

  router.get('/health', () =>
    json(200, {
      ok: true,
      version: options.version ?? '0.1.0',
      sources: FSM_SOURCES.map((s) => ({ source: s, configured: Boolean(engine.connections[s]?.webhookSecret) })),
      crms: engine.adapters.map((a) => ({ id: a.id, label: a.label, connected: a.isConnected({ accountId: null, simulated: false, deliveryId: 'health' }) })),
    }),
  );

  // ── FSM webhook receivers ────────────────────────────────────────────────
  router.post('/webhooks/:source', async (req) => {
    const source = sourceParam(req);
    const record = await engine.ingest(source, req.rawBody, req.headers);
    // Signature/parse rejections → 401/400 so the FSM surfaces the problem. A fully failed delivery → 502
    // so the FSM redelivers (it is not marked processed, and already-delivered triggers are skipped).
    // Processed / partial / ignored / duplicate → 200; partial failures are visible and replayable in the log.
    const status = record.status === 'rejected' ? (record.signature === 'invalid' ? 401 : 400) : record.status === 'failed' ? 502 : 200;
    return json(status, { delivery: record.id, status: record.status, events: record.events.map((e) => e.type), error: record.error });
  });

  // ── Delivery logs ────────────────────────────────────────────────────────
  router.get('/api/deliveries', (req) => {
    const source = req.query.get('source');
    const status = req.query.get('status') as DeliveryStatus | null;
    const records = filterDeliveries(engine.store.deliveries, {
      source: source && isFsmSource(source) ? source : undefined,
      status: status ?? undefined,
      contactId: req.query.get('contactId') ?? undefined,
      limit: Number(req.query.get('limit') ?? 100),
    });
    return json(200, { deliveries: records, stats: deliveryStats(engine.store.deliveries) });
  });

  router.get('/api/deliveries/:id', (req) => {
    const record = engine.store.getDelivery(req.params.id!);
    if (!record) throw new HttpError(404, 'delivery not found');
    return json(200, record);
  });

  router.post('/api/deliveries/:id/replay', async (req) => {
    try {
      const record = await engine.replay(req.params.id!);
      return json(200, record);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  });

  router.get('/api/stats', () => json(200, deliveryStats(engine.store.deliveries)));

  router.get('/api/stream', () => ({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    stream: (w) => {
      w.write(`event: ready\ndata: {}\n\n`);
      const off = engine.onDelivery((record) => w.write(`event: delivery\ndata: ${JSON.stringify(record)}\n\n`));
      const ping = setInterval(() => w.write(`: ping\n\n`), 25_000);
      ping.unref?.();
      w.onClose(() => {
        off();
        clearInterval(ping);
      });
    },
  }));

  // ── Contacts, LTV, revenue attribution ───────────────────────────────────
  router.get('/api/contacts', (req) => json(200, { contacts: engine.listContacts({ q: req.query.get('q') ?? undefined, limit: Number(req.query.get('limit') ?? 200) }) }));

  router.get('/api/contacts/:id', (req) => {
    const detail = engine.contactDetail(req.params.id!);
    if (!detail) throw new HttpError(404, 'contact not found');
    return json(200, detail);
  });

  router.get('/api/revenue', () => json(200, engine.ledger.attribution()));

  // ── Review gate settings ────────────────────────────────────────────────
  router.get('/api/settings/review', () => json(200, { ...engine.reviewSettings, highValueThresholdCents: engine.highValueThresholdCents }));

  router.put('/api/settings/review', (req) => {
    const body = parseJson<Partial<ReviewGateSettings> & { highValueThresholdCents?: number }>(req);
    const next: ReviewGateSettings = { ...engine.reviewSettings };
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    for (const key of ['minSatisfaction', 'cooldownDays', 'minInvoiceCents', 'delayMinutes'] as const) {
      const v = body[key];
      if (v !== undefined) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new HttpError(400, `${key} must be a non-negative number`);
        next[key] = v;
      }
    }
    if (typeof body.requireInvoice === 'boolean') next.requireInvoice = body.requireInvoice;
    if (Array.isArray(body.excludeTags)) next.excludeTags = body.excludeTags.map((t) => String(t).toLowerCase());
    if (Array.isArray(body.channels)) next.channels = body.channels.filter((c): c is 'sms' | 'email' => c === 'sms' || c === 'email');
    if (body.highValueThresholdCents !== undefined) {
      if (typeof body.highValueThresholdCents !== 'number' || body.highValueThresholdCents < 0) throw new HttpError(400, 'highValueThresholdCents must be >= 0');
      engine.highValueThresholdCents = body.highValueThresholdCents;
    }
    engine.reviewSettings = next;
    engine.store.kvSet('settings:review', { ...next, highValueThresholdCents: engine.highValueThresholdCents });
    return json(200, { ...next, highValueThresholdCents: engine.highValueThresholdCents });
  });

  if (!sandbox) return;

  // ── FSM Sandbox Simulator ────────────────────────────────────────────────
  const inbox = new SandboxInboxAdapter();
  engine.addAdapter(inbox);
  router.get('/api/sandbox/inbox', (req) => json(200, { entries: inbox.entries.slice(0, Number(req.query.get('limit') ?? 50)) }));

  router.get('/playground', (req) =>
    html(
      renderPlayground({
        publicUrl: options.publicUrl ?? '',
        tokenRequired: Boolean(options.adminToken),
        token: req.query.get('token'),
      }),
    ),
  );

  router.get('/api/simulator/catalog', () =>
    json(200, {
      sources: FSM_SOURCES,
      scenarios: SCENARIOS.map((s) => ({ id: s, label: SCENARIO_LABELS[s] })),
      lifecycle: LIFECYCLE,
      personas: PERSONAS.map((p, i) => ({ index: i, name: `${p.firstName} ${p.lastName}`, phone: p.phone, email: p.email, leadSource: p.leadSource })),
      triggers: TRIGGER_KEYS,
      highValueThresholdCents: engine.highValueThresholdCents,
    }),
  );

  const parseSim = (req: BridgeRequest) => {
    const body = parseJson<{ source?: string; scenario?: string; jobRef?: string; persona?: number; amountCents?: number; satisfaction?: number }>(req);
    if (!isFsmSource(body.source)) throw new HttpError(400, `source must be one of ${FSM_SOURCES.join(', ')}`);
    if (body.amountCents !== undefined && (!Number.isInteger(body.amountCents) || body.amountCents < 0)) throw new HttpError(400, 'amountCents must be a non-negative integer');
    if (body.persona !== undefined && (!Number.isInteger(body.persona) || body.persona < 0)) throw new HttpError(400, 'persona must be a non-negative integer');
    return { ...body, source: body.source };
  };

  router.post('/api/simulate', async (req) => {
    const body = parseSim(req);
    if (!SCENARIOS.includes(body.scenario as Scenario)) throw new HttpError(400, `scenario must be one of ${SCENARIOS.join(', ')}`);
    const { webhook, delivery } = await runSimulation(engine, {
      source: body.source,
      scenario: body.scenario as Scenario,
      jobRef: body.jobRef,
      persona: body.persona,
      amountCents: body.amountCents,
      satisfaction: body.satisfaction,
    });
    return json(200, { jobRef: webhook.jobRef, webhook: { headers: webhook.headers, body: webhook.body }, delivery });
  });

  router.post('/api/simulate/lifecycle', async (req) => {
    const body = parseSim(req);
    const results = await runLifecycle(engine, { source: body.source, jobRef: body.jobRef, persona: body.persona, amountCents: body.amountCents });
    return json(200, { jobRef: results[0]?.webhook.jobRef, deliveries: results.map((r) => r.delivery) });
  });

  router.post('/api/sandbox/reset', () => {
    engine.store.reset();
    inbox.entries.length = 0;
    engine.sandboxFixtures.clear();
    return json(200, { ok: true });
  });
}
