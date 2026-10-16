/**
 * GoHighLevel (LeadConnector API v2) marketplace shell.
 *
 * Surfaces:
 *   - OAuth install:                 GET  /ghl/oauth/install → GET /ghl/oauth/callback
 *   - App lifecycle webhook:         POST /ghl/webhooks/app   (INSTALL / UNINSTALL, RSA `x-wh-signature`)
 *   - Custom Workflow Triggers:      POST /ghl/triggers/subscribe (GHL subscription hook) → we POST to targetUrl
 *   - Custom Workflow Actions:       POST /ghl/actions/:actionKey?key=<actionSecret>
 *   - Custom Page (iframe, SSO):     GET  /ghl/custom-page   + /ghl/sso + /ghl/page-api/*
 * Every FSM trigger also adds a contact tag (`fsm-job-completed`, `review-request-ready` …) so stock
 * "Contact Tag Added" workflows work even before an agency adopts the custom triggers.
 */
import { createVerify } from 'node:crypto';
import {
  CrmHttpError,
  deliveryStats,
  findContact,
  fireTestEvent,
  formatNational,
  header,
  html,
  HttpError,
  json,
  parseJson,
  requestJson,
  requireToken,
  ShellInputError,
  signJwt,
  signState,
  summarizeContact,
  TokenVault,
  TRIGGER_KEYS,
  TRIGGER_LABELS,
  cryptoJsAesDecrypt,
  safeCompare,
  verifyJwt,
  verifyState,
  type BridgeRequest,
  type CrmAdapter,
  type CrmContext,
  type CrmResult,
  type CustomerMetrics,
  type MarketplaceShell,
  type NormalizedEvent,
  type OAuthTokens,
  type Router,
  type ShellDeps,
  type TriggerKey,
  type TriggerPayload,
  type UnifiedContact,
} from '@ccb/core-api';
import { renderGhlCustomPage } from './custom-page.js';

export const GHL_API_VERSION = '2021-07-28';
export const GHL_SCOPES = [
  'contacts.readonly',
  'contacts.write',
  'locations.readonly',
  'locations/customFields.readonly',
  'locations/customFields.write',
  'locations/tags.write',
  'workflows.readonly',
];

export interface GhlConfig {
  clientId?: string;
  clientSecret?: string;
  /** Marketplace app "Shared Secret" used to decrypt Custom Page SSO payloads. */
  ssoSharedSecret?: string;
  /** Secret embedded in custom action execution URLs (`?key=`). */
  actionSecret?: string;
  /** PEM public key GHL uses to sign app webhooks (`x-wh-signature`). */
  webhookPublicKey?: string;
  /** Private Integration token (single sub-account installs without OAuth). */
  privateToken?: string;
  defaultLocationId?: string;
  /** FSM account id → GHL location id. */
  locationMap?: Record<string, string>;
  apiBase?: string;
  marketplaceBase?: string;
  adminToken?: string | null;
}

export interface GhlSubscription {
  id: string;
  key: TriggerKey;
  locationId: string;
  targetUrl: string;
  workflowId: string | null;
  filters: unknown[];
  createdAt: string;
}

export const GHL_TAGS: Record<TriggerKey, string> = {
  estimate_approved: 'fsm-estimate-approved',
  technician_dispatched: 'fsm-tech-dispatched',
  job_completed: 'fsm-job-completed',
  invoice_paid: 'fsm-invoice-paid',
  invoice_paid_high_value: 'fsm-invoice-paid-500',
  review_request_ready: 'review-request-ready',
};

export const GHL_CUSTOM_FIELDS = [
  { key: 'fsm_lifetime_value', name: 'FSM Lifetime Value', dataType: 'MONETORY' },
  { key: 'fsm_completed_jobs', name: 'FSM Completed Jobs', dataType: 'NUMERICAL' },
  { key: 'fsm_average_ticket', name: 'FSM Average Ticket', dataType: 'MONETORY' },
  { key: 'fsm_outstanding_balance', name: 'FSM Outstanding Balance', dataType: 'MONETORY' },
  { key: 'fsm_last_job_at', name: 'FSM Last Job Completed', dataType: 'DATE' },
  { key: 'fsm_bridge_id', name: 'FSM Bridge Contact ID', dataType: 'TEXT' },
  { key: 'fsm_records', name: 'FSM Linked Records', dataType: 'TEXT' },
];

export const GHL_ACTIONS = [
  {
    key: 'fire_test_event',
    name: 'FSM Sandbox: Fire Test Event',
    description: 'Fire a signed, realistic FSM webhook (Jobber, Housecall Pro, ServiceTitan, FieldEdge, Buildertrend) through the bridge to test this workflow.',
    inputs: [
      { key: 'source', label: 'FSM', type: 'select', options: ['jobber', 'housecallpro', 'servicetitan', 'fieldedge', 'buildertrend'] },
      { key: 'scenario', label: 'Scenario', type: 'select', options: ['estimate_approved', 'technician_dispatched', 'job_completed', 'invoice_paid', 'job_callback', 'invoice_disputed'] },
      { key: 'amount', label: 'Amount (USD)', type: 'number' },
    ],
    outputs: ['delivery_id', 'status', 'triggers_fired', 'job_ref'],
  },
  {
    key: 'lookup_customer_ltv',
    name: 'FSM: Look Up Customer Lifetime Value',
    description: 'Return unified LTV, completed jobs and average ticket for the enrolled contact across every connected FSM.',
    inputs: [
      { key: 'phone', label: 'Phone', type: 'string', default: '{{contact.phone}}' },
      { key: 'email', label: 'Email', type: 'string', default: '{{contact.email}}' },
    ],
    outputs: ['found', 'lifetime_value', 'completed_jobs', 'average_ticket', 'outstanding_balance', 'last_job_at', 'last_review_request_at'],
  },
];

function toLocationTokens(json: Record<string, unknown>, now: number): OAuthTokens {
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresAt: typeof json.expires_in === 'number' ? now + json.expires_in * 1000 : undefined,
    scope: json.scope ? String(json.scope) : undefined,
    meta: {
      ...(json.locationId ? { locationId: String(json.locationId) } : {}),
      ...(json.companyId ? { companyId: String(json.companyId) } : {}),
      ...(json.userType ? { userType: String(json.userType) } : {}),
    },
  };
}

export class GoHighLevelShell implements MarketplaceShell {
  readonly id = 'gohighlevel';
  readonly label = 'GoHighLevel';
  readonly adapter: CrmAdapter;
  readonly vault: TokenVault;
  private readonly apiBase: string;

  constructor(
    readonly deps: ShellDeps,
    readonly config: GhlConfig = {},
  ) {
    this.apiBase = (config.apiBase ?? 'https://services.leadconnectorhq.com').replace(/\/$/, '');
    this.vault = new TokenVault(deps.engine.store, 'ghl');
    this.adapter = new GhlAdapter(this);
  }

  private get store() {
    return this.deps.engine.store;
  }

  // ── Tokens & locations ─────────────────────────────────────────────────
  installedLocations(): string[] {
    return this.vault.accounts();
  }

  resolveLocation(accountId: string | null): string | null {
    if (accountId && this.config.locationMap?.[accountId]) return this.config.locationMap[accountId]!;
    if (this.config.defaultLocationId) return this.config.defaultLocationId;
    return this.installedLocations()[0] ?? null;
  }

  async accessToken(locationId: string): Promise<string | null> {
    if (this.config.privateToken && (!this.config.defaultLocationId || this.config.defaultLocationId === locationId)) return this.config.privateToken;
    const tokens = await this.vault.fresh(locationId, (t) => this.refresh(t));
    return tokens?.accessToken ?? null;
  }

  private async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    const { json: body } = await requestJson<Record<string, unknown>>({
      url: `${this.apiBase}/oauth/token`,
      method: 'POST',
      form: true,
      body: {
        client_id: this.config.clientId ?? '',
        client_secret: this.config.clientSecret ?? '',
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken ?? '',
        user_type: 'Location',
      },
      fetchImpl: this.deps.fetchImpl,
    });
    return toLocationTokens(body, Date.now());
  }

  async api<T = Record<string, unknown>>(locationId: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const token = await this.accessToken(locationId);
    if (!token) throw new CrmHttpError(`no GoHighLevel token for location ${locationId}`, 401, null);
    return requestJson<T>({
      url: `${this.apiBase}${path}`,
      method,
      body,
      headers: { authorization: `Bearer ${token}`, version: GHL_API_VERSION },
      fetchImpl: this.deps.fetchImpl,
    });
  }

  // ── Contact mapping ────────────────────────────────────────────────────
  contactMapKey(locationId: string, bridgeId: string) {
    return `ghl:contact:${locationId}:${bridgeId}`;
  }

  upsertBody(locationId: string, contact: UnifiedContact, metrics: CustomerMetrics) {
    const sources = [...new Set(contact.externalIds.map((k) => k.split(':')[1]))];
    return {
      locationId,
      firstName: contact.firstName ?? undefined,
      lastName: contact.lastName ?? undefined,
      name: contact.displayName,
      email: contact.email ?? undefined,
      phone: contact.phone ?? undefined,
      companyName: contact.companyName ?? undefined,
      address1: contact.address?.street ?? undefined,
      city: contact.address?.city ?? undefined,
      state: contact.address?.region ?? undefined,
      postalCode: contact.address?.postalCode ?? undefined,
      country: contact.address?.country ?? undefined,
      source: contact.leadSource ? `FSM · ${contact.leadSource}` : 'FSM Bridge',
      tags: [...sources.map((s) => `fsm-${s}`), ...contact.tags.map((t) => t.replace(/\s+/g, '-'))],
      dnd: contact.doNotContact || undefined,
      customFields: [
        { key: 'fsm_lifetime_value', field_value: metrics.lifetimeValueCents / 100 },
        { key: 'fsm_completed_jobs', field_value: metrics.completedJobCount },
        { key: 'fsm_average_ticket', field_value: metrics.averageTicketCents / 100 },
        { key: 'fsm_outstanding_balance', field_value: metrics.outstandingCents / 100 },
        { key: 'fsm_last_job_at', field_value: metrics.lastJobAt ?? '' },
        { key: 'fsm_bridge_id', field_value: contact.id },
        { key: 'fsm_records', field_value: contact.externalIds.map((k) => k.replace(/^ext:/, '')).join(', ') },
      ],
    };
  }

  // ── Trigger subscriptions ──────────────────────────────────────────────
  subscriptions(filter: { key?: TriggerKey; locationId?: string } = {}): GhlSubscription[] {
    return this.store
      .kvEntries<GhlSubscription>('ghl:sub:')
      .map(([, v]) => v)
      .filter((s) => (!filter.key || s.key === filter.key) && (!filter.locationId || s.locationId === filter.locationId));
  }

  // ── Routes ─────────────────────────────────────────────────────────────
  registerRoutes(router: Router): void {
    const cfg = this.config;
    const publicUrl = this.deps.publicUrl.replace(/\/$/, '');
    const redirectUri = `${publicUrl}/ghl/oauth/callback`;

    router.get('/ghl/oauth/install', () => {
      if (!cfg.clientId) throw new HttpError(503, 'GHL_CLIENT_ID is not configured');
      const url = new URL(`${(cfg.marketplaceBase ?? 'https://marketplace.gohighlevel.com').replace(/\/$/, '')}/oauth/chooselocation`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('scope', GHL_SCOPES.join(' '));
      url.searchParams.set('state', signState(this.deps.appSecret, { crm: 'ghl' }));
      return { status: 302, headers: { location: url.toString() } };
    });

    router.get('/ghl/oauth/callback', async (req) => {
      const code = req.query.get('code');
      if (!code) throw new HttpError(400, 'missing ?code');
      // GHL's chooselocation flow does not always echo `state`; when it does, it must verify.
      const state = req.query.get('state');
      if (state && !verifyState(this.deps.appSecret, state)) throw new HttpError(400, 'invalid OAuth state');
      const { json: body } = await requestJson<Record<string, unknown>>({
        url: `${this.apiBase}/oauth/token`,
        method: 'POST',
        form: true,
        body: {
          client_id: cfg.clientId ?? '',
          client_secret: cfg.clientSecret ?? '',
          grant_type: 'authorization_code',
          code,
          user_type: 'Location',
          redirect_uri: redirectUri,
        },
        fetchImpl: this.deps.fetchImpl,
      });
      const tokens = toLocationTokens(body, Date.now());
      const locationId = tokens.meta?.locationId;
      if (!locationId) throw new HttpError(400, 'GHL token response did not include a locationId (install at sub-account level)');
      this.vault.set(locationId, tokens);
      return html(
        `<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:32px"><h1>FSM Bridge connected to GoHighLevel</h1><p>Location <code>${locationId.replace(/[^\w-]/g, '')}</code> is installed. Open the <b>FSM Bridge</b> custom page in the sub-account sidebar.</p></body>`,
      );
    });

    router.post('/ghl/webhooks/app', (req) => {
      if (cfg.webhookPublicKey) {
        const sig = header(req, 'x-wh-signature');
        const ok = Boolean(sig) && createVerify('sha256').update(req.rawBody).verify(cfg.webhookPublicKey, sig!, 'base64');
        if (!ok) throw new HttpError(401, 'invalid x-wh-signature');
      }
      const body = parseJson<{ type?: string; locationId?: string }>(req);
      if (body.type === 'UNINSTALL' && body.locationId) {
        this.vault.delete(body.locationId);
        for (const sub of this.subscriptions({ locationId: body.locationId })) this.store.kvDelete(`ghl:sub:${sub.id}`);
      }
      return json(200, { ok: true });
    });

    // Custom Workflow Trigger subscription hook — GHL calls this when a workflow adds/edits/removes our trigger.
    router.post('/ghl/triggers/subscribe', (req) => {
      this.requireActionSecret(req);
      const body = parseJson<{
        triggerData?: { id?: string; key?: string; eventType?: string; targetUrl?: string; filters?: unknown[] };
        meta?: { key?: string };
        extras?: { locationId?: string; workflowId?: string };
      }>(req);
      const td = body.triggerData ?? {};
      const key = (td.key ?? body.meta?.key) as TriggerKey | undefined;
      if (!td.id || !key || !TRIGGER_KEYS.includes(key)) throw new HttpError(400, `triggerData.id and a known trigger key are required (${TRIGGER_KEYS.join(', ')})`);
      const storeKey = `ghl:sub:${td.id}`;
      if (td.eventType === 'DELETED') {
        this.store.kvDelete(storeKey);
        return json(200, { ok: true, deleted: td.id });
      }
      const locationId = body.extras?.locationId;
      if (!td.targetUrl || !locationId) throw new HttpError(400, 'triggerData.targetUrl and extras.locationId are required');
      const sub: GhlSubscription = {
        id: td.id,
        key,
        locationId,
        targetUrl: td.targetUrl,
        workflowId: body.extras?.workflowId ?? null,
        filters: td.filters ?? [],
        createdAt: new Date().toISOString(),
      };
      this.store.kvSet(storeKey, sub);
      return json(200, { ok: true, subscription: sub });
    });

    router.get('/ghl/triggers', () => json(200, { triggers: this.triggerDefinitions(), subscriptions: this.subscriptions().length }));

    // Custom Workflow Actions — execution URL configured in the marketplace app.
    router.post('/ghl/actions/:actionKey', async (req) => {
      this.requireActionSecret(req);
      const body = parseJson<{ data?: Record<string, unknown>; extras?: { locationId?: string; contactId?: string } }>(req);
      const data = body.data ?? {};
      try {
        switch (req.params.actionKey) {
          case 'fire_test_event': {
            const { delivery, jobRef } = await fireTestEvent(this.deps.engine, data);
            return json(200, {
              delivery_id: delivery.id,
              status: delivery.status,
              triggers_fired: delivery.triggers.filter((t) => t.fired).map((t) => t.key).join(','),
              job_ref: jobRef,
            });
          }
          case 'lookup_customer_ltv': {
            const contact = findContact(this.deps.engine, { phone: data.phone, email: data.email });
            return json(200, summarizeContact(contact, contact ? this.deps.engine.ledger.metrics(contact.id) : undefined));
          }
          default:
            throw new HttpError(404, `unknown action ${req.params.actionKey}`);
        }
      } catch (err) {
        if (err instanceof ShellInputError) throw new HttpError(400, err.message);
        throw err;
      }
    });

    // Custom Page (iframe inside the GHL sub-account)
    router.get('/ghl/custom-page', (req) =>
      html(renderGhlCustomPage({ ssoEnabled: Boolean(cfg.ssoSharedSecret), devToken: req.query.get('token') }), 200, {
        'content-security-policy': "frame-ancestors 'self' https://*.gohighlevel.com https://*.leadconnectorhq.com https://*.msgsndr.com",
      }),
    );

    router.post('/ghl/sso', (req) => {
      if (!cfg.ssoSharedSecret) throw new HttpError(503, 'GHL SSO shared secret is not configured');
      const { payload } = parseJson<{ payload?: string }>(req);
      if (!payload) throw new HttpError(400, 'payload is required');
      let user: Record<string, unknown>;
      try {
        user = JSON.parse(cryptoJsAesDecrypt(payload, cfg.ssoSharedSecret)) as Record<string, unknown>;
      } catch {
        throw new HttpError(401, 'could not decrypt SSO payload');
      }
      const locationId = typeof user.activeLocation === 'string' ? user.activeLocation : null;
      const session = signJwt(
        { sub: user.userId ?? null, loc: locationId, cmp: user.companyId ?? null, role: user.role ?? null, aud: 'ghl-page' },
        this.deps.appSecret,
        { expiresInSeconds: 8 * 3600 },
      );
      return json(200, { session, user: { userId: user.userId, userName: user.userName, email: user.email, role: user.role, locationId } });
    });

    const adminGuard = requireToken(cfg.adminToken);
    router.guard('/ghl/page-api', (req) => {
      const auth = header(req, 'authorization') ?? (req.query.get('session') ? `Bearer ${req.query.get('session')}` : undefined);
      const session = verifyJwt(auth?.replace(/^Bearer /, ''), this.deps.appSecret);
      if (session && session.aud === 'ghl-page') return null;
      return adminGuard(req);
    });

    router.get('/ghl/page-api/overview', () => {
      const engine = this.deps.engine;
      return json(200, {
        stats: deliveryStats(engine.store.deliveries),
        deliveries: engine.store.deliveries.slice(0, 50).map((d) => ({
          id: d.id,
          source: d.source,
          status: d.status,
          receivedAt: d.receivedAt,
          simulated: d.simulated,
          event: d.events.map((e) => e.type).join(', ') || d.rawEventName,
          triggers: d.triggers.filter((t) => t.fired).map((t) => t.key),
          ghl: d.crm.filter((c) => c.target === this.id),
          error: d.error,
          steps: d.steps,
        })),
        revenue: engine.ledger.attribution(),
        topCustomers: engine.listContacts({ limit: 10 }).map((c) => ({
          name: c.displayName,
          phone: formatNational(c.phone),
          ltv: c.metrics.lifetimeValueCents / 100,
          jobs: c.metrics.completedJobCount,
          sources: c.externalIds.map((k) => k.split(':')[1]),
        })),
        installedLocations: this.installedLocations(),
        subscriptions: this.subscriptions().map((s) => ({ key: s.key, locationId: s.locationId, workflowId: s.workflowId })),
      });
    });

    router.post('/ghl/page-api/test', async (req) => {
      try {
        const { delivery } = await fireTestEvent(this.deps.engine, parseJson(req));
        return json(200, { delivery });
      } catch (err) {
        if (err instanceof ShellInputError) throw new HttpError(400, err.message);
        throw err;
      }
    });

    router.post('/ghl/page-api/replay/:id', async (req) => {
      try {
        return json(200, { delivery: await this.deps.engine.replay(req.params.id!) });
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
    });

    router.post('/ghl/setup/custom-fields', async (req) => {
      const guard = adminGuard(req);
      if (guard) return guard;
      const { locationId } = parseJson<{ locationId?: string }>(req);
      const loc = locationId ?? this.resolveLocation(null);
      if (!loc) throw new HttpError(400, 'no location installed');
      const results = [];
      for (const field of GHL_CUSTOM_FIELDS) {
        try {
          await this.api(loc, 'POST', `/locations/${encodeURIComponent(loc)}/customFields`, { name: field.name, dataType: field.dataType, fieldKey: `contact.${field.key}`, model: 'contact' });
          results.push({ key: field.key, ok: true });
        } catch (err) {
          results.push({ key: field.key, ok: false, error: (err as Error).message });
        }
      }
      return json(200, { locationId: loc, results });
    });
  }

  private requireActionSecret(req: BridgeRequest): void {
    const secret = this.config.actionSecret;
    if (!secret) return;
    const provided = req.query.get('key') ?? header(req, 'x-bridge-action-secret');
    if (!provided || !safeCompare(provided, secret)) throw new HttpError(401, 'invalid action key');
  }

  triggerDefinitions() {
    return TRIGGER_KEYS.map((key) => ({
      key,
      name: TRIGGER_LABELS[key]!.name,
      description: TRIGGER_LABELS[key]!.description,
      tag: GHL_TAGS[key],
      sampleFields: [
        'contact_name', 'contact_phone', 'contact_email', 'fsm_source', 'job_number', 'job_title', 'technician_names',
        'invoice_total', 'estimate_total', 'lifetime_value', 'completed_jobs', 'review_eligible', 'review_channels',
      ],
    }));
  }

  manifest() {
    const base = this.deps.publicUrl.replace(/\/$/, '');
    const key = this.config.actionSecret ? '?key=<GHL_ACTION_SECRET>' : '';
    return {
      crm: this.id,
      distribution: 'Sub-account (Location) app',
      scopes: GHL_SCOPES,
      redirectUri: `${base}/ghl/oauth/callback`,
      installUrl: `${base}/ghl/oauth/install`,
      webhookUrl: `${base}/ghl/webhooks/app`,
      customPage: { name: 'FSM Bridge', url: `${base}/ghl/custom-page` },
      triggers: this.triggerDefinitions().map((t) => ({ ...t, subscriptionUrl: `${base}/ghl/triggers/subscribe${key}` })),
      actions: GHL_ACTIONS.map((a) => ({ ...a, executionUrl: `${base}/ghl/actions/${a.key}${key}` })),
      customFields: GHL_CUSTOM_FIELDS,
    };
  }
}

class GhlAdapter implements CrmAdapter {
  readonly id = 'gohighlevel';
  readonly label = 'GoHighLevel';

  constructor(private readonly shell: GoHighLevelShell) {}

  isConnected(ctx: CrmContext): boolean {
    return Boolean(this.shell.resolveLocation(ctx.accountId) && (this.shell.config.privateToken || this.shell.installedLocations().length));
  }

  async syncContact(contact: UnifiedContact, metrics: CustomerMetrics, _event: NormalizedEvent, ctx: CrmContext): Promise<CrmResult> {
    const locationId = this.shell.resolveLocation(ctx.accountId)!;
    const { status, json: body } = await this.shell.api<{ contact?: { id?: string }; new?: boolean }>(
      locationId,
      'POST',
      '/contacts/upsert',
      this.shell.upsertBody(locationId, contact, metrics),
    );
    const ghlId = body.contact?.id;
    if (ghlId) this.shell.deps.engine.store.kvSet(this.shell.contactMapKey(locationId, contact.id), ghlId);
    return { ok: true, action: 'contact.upsert', status, externalId: ghlId, detail: body.new ? 'created' : 'updated' };
  }

  async deliverTrigger(trigger: TriggerPayload, ctx: CrmContext): Promise<CrmResult> {
    const locationId = this.shell.resolveLocation(ctx.accountId)!;
    const ghlContactId = this.shell.deps.engine.store.kvGet<string>(this.shell.contactMapKey(locationId, trigger.contact.id));
    const details: string[] = [];
    let lastStatus: number | undefined;
    if (ghlContactId) {
      const { status } = await this.shell.api(locationId, 'POST', `/contacts/${encodeURIComponent(ghlContactId)}/tags`, { tags: [GHL_TAGS[trigger.key]] });
      lastStatus = status;
      details.push(`tag ${GHL_TAGS[trigger.key]}`);
    }
    const subs = this.shell.subscriptions({ key: trigger.key, locationId });
    for (const sub of subs) {
      const token = await this.shell.accessToken(locationId);
      const { status } = await requestJson({
        url: sub.targetUrl,
        method: 'POST',
        headers: { authorization: `Bearer ${token ?? ''}`, version: GHL_API_VERSION },
        body: { ...trigger.fields, contactId: ghlContactId ?? null, locationId },
        fetchImpl: this.shell.deps.fetchImpl,
      });
      lastStatus = status;
    }
    if (subs.length) details.push(`${subs.length} workflow subscription(s)`);
    if (!details.length) return { ok: true, action: `trigger.${trigger.key}`, skipped: true, detail: 'no GHL contact id or workflow subscriptions yet' };
    return { ok: true, action: `trigger.${trigger.key}`, status: lastStatus, externalId: ghlContactId, detail: details.join(' + ') };
  }
}

export function createGoHighLevelShell(deps: ShellDeps, config: GhlConfig = {}): GoHighLevelShell {
  return new GoHighLevelShell(deps, config);
}
