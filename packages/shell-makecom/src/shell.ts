/**
 * Make (formerly Integromat) custom-app shell.
 *
 * Make apps are declarative (IML JSON). `makeAppDefinition()` emits the Base, Connection, Webhook and
 * Module definitions; this shell implements the REST endpoints those definitions call:
 *   - POST   /make/hooks          attach an instant-trigger webhook  ({ url, trigger }) → { id }
 *   - DELETE /make/hooks/:id      detach
 *   - GET    /make/me             connection test
 *   - GET    /make/customers      search customers (q, phone, email)
 *   - GET    /make/customers/:id  get customer + LTV
 *   - POST   /make/simulate       fire a sandbox FSM event
 *   - GET    /make/deliveries     list webhook deliveries (for error-handling routes)
 * Auth: `Authorization: Bearer <MAKE_API_KEY>` (one of the configured keys).
 */
import {
  CrmHttpError,
  findContact,
  fireTestEvent,
  HttpError,
  json,
  parseJson,
  requestJson,
  safeCompare,
  ShellInputError,
  summarizeContact,
  TRIGGER_KEYS,
  TRIGGER_LABELS,
  tokenFrom,
  type BridgeRequest,
  type CrmAdapter,
  type CrmContext,
  type CrmResult,
  type CustomerMetrics,
  type MarketplaceShell,
  type NormalizedEvent,
  type Router,
  type ShellDeps,
  type TriggerPayload,
  type UnifiedContact,
} from '@ccb/core-api';

export const MAKE_HOOK_TYPES = [...TRIGGER_KEYS, 'contact_synced', 'all'] as const;
export type MakeHookType = (typeof MAKE_HOOK_TYPES)[number];

export interface MakeConfig {
  apiKeys?: string[];
}

export interface MakeHook {
  id: string;
  url: string;
  trigger: MakeHookType;
  createdAt: string;
}

export class MakeShell implements MarketplaceShell {
  readonly id = 'makecom';
  readonly label = 'Make';
  readonly adapter: CrmAdapter;

  constructor(
    readonly deps: ShellDeps,
    readonly config: MakeConfig = {},
  ) {
    this.adapter = new MakeAdapter(this);
  }

  hooks(trigger?: string): MakeHook[] {
    return this.deps.engine.store
      .kvEntries<MakeHook>('make:hook:')
      .map(([, v]) => v)
      .filter((h) => !trigger || h.trigger === trigger || h.trigger === 'all');
  }

  private authorize(req: BridgeRequest): void {
    const keys = this.config.apiKeys ?? [];
    if (!keys.length) throw new HttpError(503, 'MAKE_API_KEYS is not configured');
    const provided = tokenFrom(req) ?? req.query.get('api_key');
    if (!provided || !keys.some((k) => safeCompare(k, provided))) throw new HttpError(401, 'invalid API key');
  }

  registerRoutes(router: Router): void {
    const auth = (req: BridgeRequest) => {
      try {
        this.authorize(req);
        return null;
      } catch (err) {
        const e = err as HttpError;
        return json(e.status, { error: e.message });
      }
    };
    router.guard('/make', auth);

    router.get('/make/me', () => json(200, { ok: true, app: 'contractor-crm-bridge', hooks: this.hooks().length }));

    router.post('/make/hooks', (req) => {
      const body = parseJson<{ url?: string; trigger?: string }>(req);
      if (!body.url || !/^https?:\/\//.test(body.url)) throw new HttpError(400, 'url must be an http(s) URL');
      const trigger = (body.trigger ?? 'all') as MakeHookType;
      if (!MAKE_HOOK_TYPES.includes(trigger)) throw new HttpError(400, `trigger must be one of ${MAKE_HOOK_TYPES.join(', ')}`);
      const hook: MakeHook = { id: `mk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, url: body.url, trigger, createdAt: new Date().toISOString() };
      this.deps.engine.store.kvSet(`make:hook:${hook.id}`, hook);
      return json(201, hook);
    });

    router.get('/make/hooks', () => json(200, { hooks: this.hooks() }));

    router.delete('/make/hooks/:id', (req) => {
      this.deps.engine.store.kvDelete(`make:hook:${req.params.id}`);
      return json(200, { ok: true });
    });

    router.get('/make/customers', (req) => {
      const phone = req.query.get('phone');
      const email = req.query.get('email');
      if (phone || email) {
        const c = findContact(this.deps.engine, { phone, email });
        return json(200, { customers: c ? [summarizeContact(c, this.deps.engine.ledger.metrics(c.id))] : [] });
      }
      const list = this.deps.engine.listContacts({ q: req.query.get('q') ?? undefined, limit: Number(req.query.get('limit') ?? 50) });
      return json(200, { customers: list.map((c) => summarizeContact(c, c.metrics)) });
    });

    router.get('/make/customers/:id', (req) => {
      const detail = this.deps.engine.contactDetail(req.params.id!);
      if (!detail) throw new HttpError(404, 'customer not found');
      return json(200, { ...summarizeContact(detail.contact, detail.metrics), jobs: detail.jobs, invoices: detail.invoices });
    });

    router.post('/make/simulate', async (req) => {
      try {
        const { delivery, jobRef } = await fireTestEvent(this.deps.engine, parseJson(req));
        return json(200, { delivery_id: delivery.id, status: delivery.status, job_ref: jobRef, triggers: delivery.triggers.filter((t) => t.fired).map((t) => t.key) });
      } catch (err) {
        if (err instanceof ShellInputError) throw new HttpError(400, err.message);
        throw err;
      }
    });

    router.get('/make/deliveries', (req) => {
      const status = req.query.get('status');
      const list = this.deps.engine.store.deliveries.filter((d) => !status || d.status === status).slice(0, Number(req.query.get('limit') ?? 50));
      return json(200, {
        deliveries: list.map((d) => ({ id: d.id, source: d.source, status: d.status, received_at: d.receivedAt, events: d.events.map((e) => e.type), error: d.error })),
      });
    });

    router.get('/make/app-definition', () => json(200, makeAppDefinition(this.deps.publicUrl)));
  }

  manifest() {
    return { crm: this.id, definition: makeAppDefinition(this.deps.publicUrl) };
  }
}

class MakeAdapter implements CrmAdapter {
  readonly id = 'makecom';
  readonly label = 'Make';

  constructor(private readonly shell: MakeShell) {}

  isConnected(_ctx: CrmContext): boolean {
    return this.shell.hooks().length > 0;
  }

  private async post(url: string, body: unknown) {
    return requestJson({ url, method: 'POST', body, fetchImpl: this.shell.deps.fetchImpl });
  }

  async syncContact(contact: UnifiedContact, metrics: CustomerMetrics, event: NormalizedEvent): Promise<CrmResult> {
    const hooks = this.shell.hooks('contact_synced').filter((h) => h.trigger === 'contact_synced');
    if (!hooks.length) return { ok: true, action: 'contact.upsert', skipped: true, detail: 'no contact_synced scenario attached' };
    for (const h of hooks) await this.post(h.url, { trigger: 'contact_synced', fsm_event: event.type, ...summarizeContact(contact, metrics) });
    return { ok: true, action: 'contact.upsert', detail: `${hooks.length} scenario(s)` };
  }

  async deliverTrigger(trigger: TriggerPayload): Promise<CrmResult> {
    const hooks = this.shell.hooks(trigger.key);
    if (!hooks.length) return { ok: true, action: `trigger.${trigger.key}`, skipped: true, detail: 'no scenario attached for this trigger' };
    let last = 0;
    for (const h of hooks) {
      const r = await this.post(h.url, trigger.fields);
      last = r.status;
    }
    if (last >= 300) throw new CrmHttpError('Make webhook rejected the payload', last, null);
    return { ok: true, action: `trigger.${trigger.key}`, status: last, detail: `${hooks.length} scenario(s)` };
  }
}

const TRIGGER_OUTPUT_SPEC = [
  { name: 'trigger', type: 'text', label: 'Trigger' },
  { name: 'trigger_id', type: 'text', label: 'Trigger ID' },
  { name: 'occurred_at', type: 'date', label: 'Occurred at' },
  { name: 'fsm_source', type: 'text', label: 'FSM' },
  { name: 'contact_id', type: 'text', label: 'Bridge contact ID' },
  { name: 'contact_name', type: 'text', label: 'Customer name' },
  { name: 'contact_first_name', type: 'text', label: 'First name' },
  { name: 'contact_last_name', type: 'text', label: 'Last name' },
  { name: 'contact_phone', type: 'text', label: 'Phone (E.164)' },
  { name: 'contact_email', type: 'email', label: 'Email' },
  { name: 'job_id', type: 'text', label: 'Job ID' },
  { name: 'job_title', type: 'text', label: 'Job title' },
  { name: 'technician_names', type: 'text', label: 'Technicians' },
  { name: 'invoice_total', type: 'number', label: 'Invoice total' },
  { name: 'estimate_total', type: 'number', label: 'Estimate total' },
  { name: 'lifetime_value', type: 'number', label: 'Lifetime value' },
  { name: 'completed_jobs', type: 'uinteger', label: 'Completed jobs' },
  { name: 'review_eligible', type: 'boolean', label: 'Review eligible' },
  { name: 'review_channels', type: 'text', label: 'Review channels' },
];

/** Make custom-app definition (Base / Connection / Webhooks / Modules) pointing at this gateway. */
export function makeAppDefinition(publicUrl: string) {
  const baseUrl = publicUrl.replace(/\/$/, '');
  const webhooks = TRIGGER_KEYS.map((key) => ({
    name: `fsm_${key}`,
    label: TRIGGER_LABELS[key]!.name,
    type: 'dedicated',
    connection: 'bridge',
    attach: {
      url: '/make/hooks',
      method: 'POST',
      body: { url: '{{webhook.url}}', trigger: key },
      response: { data: { externalHookId: '{{body.id}}' } },
    },
    detach: { url: '/make/hooks/{{webhook.externalHookId}}', method: 'DELETE' },
  }));
  return {
    base: {
      baseUrl,
      headers: { authorization: 'Bearer {{connection.apiKey}}' },
      response: { error: { message: '[{{statusCode}}] {{body.error}}' } },
      log: { sanitize: ['request.headers.authorization'] },
    },
    connections: [
      {
        name: 'bridge',
        label: 'Contractor CRM Bridge',
        type: 'apikey',
        parameters: [{ name: 'apiKey', type: 'password', label: 'API key', required: true }],
        communication: { url: `${baseUrl}/make/me`, headers: { authorization: 'Bearer {{parameters.apiKey}}' } },
      },
    ],
    webhooks,
    modules: [
      ...TRIGGER_KEYS.map((key) => ({
        name: `watch_${key}`,
        type: 'instant_trigger',
        label: `Watch ${TRIGGER_LABELS[key]!.name.replace('FSM: ', '')}`,
        description: TRIGGER_LABELS[key]!.description,
        webhook: `fsm_${key}`,
        communication: { output: '{{body}}' },
        interface: TRIGGER_OUTPUT_SPEC,
      })),
      {
        name: 'fire_test_event',
        type: 'action',
        label: 'Fire FSM Sandbox Event',
        connection: 'bridge',
        communication: { url: '/make/simulate', method: 'POST', body: '{{parameters}}', response: { output: '{{body}}' } },
        parameters: [
          { name: 'source', type: 'select', label: 'FSM', required: true, options: ['jobber', 'housecallpro', 'servicetitan', 'fieldedge', 'buildertrend'].map((v) => ({ label: v, value: v })) },
          { name: 'scenario', type: 'select', label: 'Scenario', required: true, options: ['estimate_approved', 'technician_dispatched', 'job_completed', 'invoice_paid', 'job_callback', 'invoice_disputed'].map((v) => ({ label: v, value: v })) },
          { name: 'amount', type: 'number', label: 'Amount (USD)' },
          { name: 'job_ref', type: 'text', label: 'Job reference (reuse to chain events)' },
        ],
        interface: [
          { name: 'delivery_id', type: 'text' },
          { name: 'status', type: 'text' },
          { name: 'job_ref', type: 'text' },
          { name: 'triggers', type: 'array', spec: { type: 'text' } },
        ],
      },
      {
        name: 'search_customers',
        type: 'search',
        label: 'Search Customers (LTV)',
        connection: 'bridge',
        communication: { url: '/make/customers', method: 'GET', qs: { q: '{{parameters.q}}', phone: '{{parameters.phone}}', email: '{{parameters.email}}' }, response: { iterate: '{{body.customers}}', output: '{{item}}' } },
        parameters: [
          { name: 'q', type: 'text', label: 'Query' },
          { name: 'phone', type: 'text', label: 'Phone' },
          { name: 'email', type: 'email', label: 'Email' },
        ],
      },
      {
        name: 'get_customer',
        type: 'action',
        label: 'Get a Customer',
        connection: 'bridge',
        communication: { url: '/make/customers/{{parameters.id}}', method: 'GET', response: { output: '{{body}}' } },
        parameters: [{ name: 'id', type: 'text', label: 'Bridge contact ID', required: true }],
      },
      {
        name: 'list_failed_deliveries',
        type: 'search',
        label: 'List Failed Webhook Deliveries',
        connection: 'bridge',
        communication: { url: '/make/deliveries', method: 'GET', qs: { status: 'failed' }, response: { iterate: '{{body.deliveries}}', output: '{{item}}' } },
        parameters: [],
      },
    ],
  };
}

export function createMakeShell(deps: ShellDeps, config: MakeConfig = {}): MakeShell {
  return new MakeShell(deps, config);
}
