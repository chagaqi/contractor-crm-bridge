/**
 * HubSpot public-app shell.
 *
 * Surfaces:
 *   - OAuth:                      GET  /hubspot/oauth/install → /hubspot/oauth/callback
 *   - Contact sync:               search (fsm_bridge_id | email | phone) → PATCH or POST /crm/v3/objects/contacts
 *   - Trigger delivery:           contact properties (fsm_last_trigger …) so workflows can enroll on change,
 *                                 + deals for approved estimates, + optional timeline events
 *   - Custom workflow actions:    POST /hubspot/actions/:actionKey   (X-HubSpot-Signature-v3 verified)
 *   - CRM card (data fetch):      GET  /hubspot/crm-card              (X-HubSpot-Signature-v3 verified)
 *   - Property bootstrap:         POST /hubspot/setup/properties
 */
import { createHmac } from 'node:crypto';
import {
  CrmHttpError,
  findContact,
  fireTestEvent,
  header,
  html,
  HttpError,
  json,
  parseJson,
  requestJson,
  requireToken,
  safeCompare,
  ShellInputError,
  signState,
  summarizeContact,
  TokenVault,
  TRIGGER_KEYS,
  TRIGGER_LABELS,
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
  type TriggerPayload,
  type UnifiedContact,
} from '@ccb/core-api';

export const HUBSPOT_SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.schemas.contacts.write',
  'timeline',
  'automation',
];

export interface HubSpotConfig {
  clientId?: string;
  clientSecret?: string;
  appId?: string;
  /** Private app token (single portal, no OAuth). */
  privateAppToken?: string;
  defaultPortalId?: string;
  /** FSM account id → HubSpot portal id. */
  portalMap?: Record<string, string>;
  apiBase?: string;
  appBase?: string;
  /** Timeline event template id per trigger key (created in the developer portal). */
  timelineTemplates?: Partial<Record<string, string>>;
  dealPipeline?: string;
  dealStageWon?: string;
  adminToken?: string | null;
}

export const HUBSPOT_PROPERTY_GROUP = { name: 'fsm_bridge', label: 'Field Service (FSM Bridge)', displayOrder: 1 };

export const HUBSPOT_PROPERTIES = [
  { name: 'fsm_bridge_id', label: 'FSM Bridge ID', type: 'string', fieldType: 'text', hasUniqueValue: true },
  { name: 'fsm_lifetime_value', label: 'FSM Lifetime Value', type: 'number', fieldType: 'number' },
  { name: 'fsm_completed_jobs', label: 'FSM Completed Jobs', type: 'number', fieldType: 'number' },
  { name: 'fsm_average_ticket', label: 'FSM Average Ticket', type: 'number', fieldType: 'number' },
  { name: 'fsm_outstanding_balance', label: 'FSM Outstanding Balance', type: 'number', fieldType: 'number' },
  { name: 'fsm_last_job_at', label: 'FSM Last Job Completed', type: 'datetime', fieldType: 'date' },
  { name: 'fsm_sources', label: 'FSM Sources', type: 'string', fieldType: 'text' },
  { name: 'fsm_lead_source', label: 'FSM Lead Source', type: 'string', fieldType: 'text' },
  {
    name: 'fsm_last_trigger',
    label: 'FSM Last Trigger',
    type: 'enumeration',
    fieldType: 'select',
    options: TRIGGER_KEYS.map((k, i) => ({ label: TRIGGER_LABELS[k]!.name.replace('FSM: ', ''), value: k, displayOrder: i })),
  },
  { name: 'fsm_last_trigger_at', label: 'FSM Last Trigger At', type: 'datetime', fieldType: 'date' },
  { name: 'fsm_review_requested_at', label: 'FSM Review Requested At', type: 'datetime', fieldType: 'date' },
  { name: 'fsm_review_channels', label: 'FSM Review Channels', type: 'string', fieldType: 'text' },
];

export interface HubSpotSignatureInput {
  clientSecret: string;
  method: string;
  url: string;
  body: string;
  timestamp: string;
}

/** X-HubSpot-Signature-v3 = base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp)). */
export function hubspotSignatureV3(i: HubSpotSignatureInput): string {
  return createHmac('sha256', i.clientSecret).update(`${i.method.toUpperCase()}${i.url}${i.body}${i.timestamp}`).digest('base64');
}

export function verifyHubSpotRequest(req: BridgeRequest, clientSecret: string, now = Date.now()): { ok: boolean; reason?: string } {
  const sig = header(req, 'x-hubspot-signature-v3');
  const ts = header(req, 'x-hubspot-request-timestamp');
  if (!sig || !ts) return { ok: false, reason: 'missing X-HubSpot-Signature-v3 / X-HubSpot-Request-Timestamp' };
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > 5 * 60_000) return { ok: false, reason: 'timestamp outside 5 minute window' };
  const expected = hubspotSignatureV3({ clientSecret, method: req.method, url: decodeURIComponent(req.url), body: req.rawBody, timestamp: ts });
  return safeCompare(expected, sig) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

export const HUBSPOT_ACTIONS = [
  {
    key: 'fire_test_event',
    labels: { actionName: 'FSM Sandbox: fire test event', actionDescription: 'Fire a signed sandbox FSM webhook through the bridge to test this workflow.' },
    inputFields: [
      { typeDefinition: { name: 'source', type: 'enumeration', fieldType: 'select', options: ['jobber', 'housecallpro', 'servicetitan', 'fieldedge', 'buildertrend'].map((v) => ({ label: v, value: v })) }, isRequired: true },
      { typeDefinition: { name: 'scenario', type: 'enumeration', fieldType: 'select', options: ['estimate_approved', 'technician_dispatched', 'job_completed', 'invoice_paid'].map((v) => ({ label: v, value: v })) }, isRequired: true },
      { typeDefinition: { name: 'amount', type: 'number', fieldType: 'number' }, isRequired: false },
    ],
    outputFields: [
      { typeDefinition: { name: 'delivery_id', type: 'string', fieldType: 'text' } },
      { typeDefinition: { name: 'status', type: 'string', fieldType: 'text' } },
      { typeDefinition: { name: 'triggers_fired', type: 'string', fieldType: 'text' } },
    ],
  },
  {
    key: 'get_fsm_ltv',
    labels: { actionName: 'FSM: get customer lifetime value', actionDescription: 'Look up unified LTV, completed jobs and average ticket across every connected FSM.' },
    inputFields: [
      { typeDefinition: { name: 'email', type: 'string', fieldType: 'text' }, supportedValueTypes: ['OBJECT_PROPERTY', 'STATIC_VALUE'], isRequired: false },
      { typeDefinition: { name: 'phone', type: 'string', fieldType: 'phonenumber' }, supportedValueTypes: ['OBJECT_PROPERTY', 'STATIC_VALUE'], isRequired: false },
    ],
    outputFields: [
      { typeDefinition: { name: 'lifetime_value', type: 'number', fieldType: 'number' } },
      { typeDefinition: { name: 'completed_jobs', type: 'number', fieldType: 'number' } },
      { typeDefinition: { name: 'average_ticket', type: 'number', fieldType: 'number' } },
    ],
  },
];

export class HubSpotShell implements MarketplaceShell {
  readonly id = 'hubspot';
  readonly label = 'HubSpot';
  readonly adapter: CrmAdapter;
  readonly vault: TokenVault;
  readonly apiBase: string;

  constructor(
    readonly deps: ShellDeps,
    readonly config: HubSpotConfig = {},
  ) {
    this.apiBase = (config.apiBase ?? 'https://api.hubapi.com').replace(/\/$/, '');
    this.vault = new TokenVault(deps.engine.store, 'hubspot');
    this.adapter = new HubSpotAdapter(this);
  }

  resolvePortal(accountId: string | null): string | null {
    if (accountId && this.config.portalMap?.[accountId]) return this.config.portalMap[accountId]!;
    if (this.config.defaultPortalId) return this.config.defaultPortalId;
    if (this.config.privateAppToken) return 'private';
    return this.vault.accounts()[0] ?? null;
  }

  async token(portalId: string): Promise<string | null> {
    if (this.config.privateAppToken && (portalId === 'private' || portalId === this.config.defaultPortalId)) return this.config.privateAppToken;
    const t = await this.vault.fresh(portalId, (tokens) => this.refresh(tokens));
    return t?.accessToken ?? null;
  }

  private async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    const { json: body } = await requestJson<Record<string, unknown>>({
      url: `${this.apiBase}/oauth/v1/token`,
      method: 'POST',
      form: true,
      body: { grant_type: 'refresh_token', client_id: this.config.clientId ?? '', client_secret: this.config.clientSecret ?? '', refresh_token: tokens.refreshToken ?? '' },
      fetchImpl: this.deps.fetchImpl,
    });
    return {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token ?? tokens.refreshToken),
      expiresAt: Date.now() + Number(body.expires_in ?? 1800) * 1000,
    };
  }

  async api<T = Record<string, unknown>>(portalId: string, method: string, path: string, body?: unknown) {
    const token = await this.token(portalId);
    if (!token) throw new CrmHttpError(`no HubSpot token for portal ${portalId}`, 401, null);
    return requestJson<T>({ url: `${this.apiBase}${path}`, method, body, headers: { authorization: `Bearer ${token}` }, fetchImpl: this.deps.fetchImpl });
  }

  contactProperties(contact: UnifiedContact, metrics: CustomerMetrics): Record<string, string> {
    const props: Record<string, string | null | undefined> = {
      firstname: contact.firstName,
      lastname: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      company: contact.companyName,
      address: contact.address?.street,
      city: contact.address?.city,
      state: contact.address?.region,
      zip: contact.address?.postalCode,
      country: contact.address?.country,
      fsm_bridge_id: contact.id,
      fsm_lifetime_value: String(metrics.lifetimeValueCents / 100),
      fsm_completed_jobs: String(metrics.completedJobCount),
      fsm_average_ticket: String(metrics.averageTicketCents / 100),
      fsm_outstanding_balance: String(metrics.outstandingCents / 100),
      fsm_last_job_at: metrics.lastJobAt ?? undefined,
      fsm_sources: [...new Set(contact.externalIds.map((k) => k.split(':')[1]))].join(';'),
      fsm_lead_source: contact.leadSource,
    };
    return Object.fromEntries(Object.entries(props).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
  }

  mapKey(portalId: string, bridgeId: string) {
    return `hubspot:contact:${portalId}:${bridgeId}`;
  }

  registerRoutes(router: Router): void {
    const cfg = this.config;
    const base = this.deps.publicUrl.replace(/\/$/, '');
    const redirectUri = `${base}/hubspot/oauth/callback`;

    router.get('/hubspot/oauth/install', () => {
      if (!cfg.clientId) throw new HttpError(503, 'HUBSPOT_CLIENT_ID is not configured');
      const url = new URL(`${(cfg.appBase ?? 'https://app.hubspot.com').replace(/\/$/, '')}/oauth/authorize`);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', HUBSPOT_SCOPES.join(' '));
      url.searchParams.set('state', signState(this.deps.appSecret, { crm: 'hubspot' }));
      return { status: 302, headers: { location: url.toString() } };
    });

    router.get('/hubspot/oauth/callback', async (req) => {
      const code = req.query.get('code');
      if (!code) throw new HttpError(400, 'missing ?code');
      if (!verifyState(this.deps.appSecret, req.query.get('state'))) throw new HttpError(400, 'invalid OAuth state');
      const { json: tok } = await requestJson<Record<string, unknown>>({
        url: `${this.apiBase}/oauth/v1/token`,
        method: 'POST',
        form: true,
        body: { grant_type: 'authorization_code', client_id: cfg.clientId ?? '', client_secret: cfg.clientSecret ?? '', redirect_uri: redirectUri, code },
        fetchImpl: this.deps.fetchImpl,
      });
      const accessToken = String(tok.access_token);
      const { json: info } = await requestJson<Record<string, unknown>>({
        url: `${this.apiBase}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`,
        fetchImpl: this.deps.fetchImpl,
      });
      const portalId = String(info.hub_id ?? info.hubId ?? '');
      if (!portalId) throw new HttpError(502, 'could not resolve HubSpot portal id');
      this.vault.set(portalId, {
        accessToken,
        refreshToken: String(tok.refresh_token ?? ''),
        expiresAt: Date.now() + Number(tok.expires_in ?? 1800) * 1000,
        meta: { portalId, hubDomain: String(info.hub_domain ?? '') },
      });
      return html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:32px"><h1>FSM Bridge connected to HubSpot</h1><p>Portal <code>${portalId.replace(/\D/g, '')}</code> installed.</p></body>`);
    });

    const verify = (req: BridgeRequest) => {
      if (!cfg.clientSecret) return;
      const v = verifyHubSpotRequest(req, cfg.clientSecret);
      if (!v.ok) throw new HttpError(401, `invalid HubSpot signature: ${v.reason}`);
    };

    router.post('/hubspot/actions/:actionKey', async (req) => {
      verify(req);
      const body = parseJson<{ inputFields?: Record<string, unknown>; object?: { objectId?: number } }>(req);
      const inputs = body.inputFields ?? {};
      try {
        switch (req.params.actionKey) {
          case 'fire_test_event': {
            const { delivery } = await fireTestEvent(this.deps.engine, inputs);
            return json(200, { outputFields: { delivery_id: delivery.id, status: delivery.status, triggers_fired: delivery.triggers.filter((t) => t.fired).map((t) => t.key).join(',') } });
          }
          case 'get_fsm_ltv': {
            const c = findContact(this.deps.engine, { email: inputs.email, phone: inputs.phone });
            const s = summarizeContact(c, c ? this.deps.engine.ledger.metrics(c.id) : undefined);
            return json(200, { outputFields: { lifetime_value: s.lifetime_value, completed_jobs: s.completed_jobs, average_ticket: s.average_ticket } });
          }
          default:
            throw new HttpError(404, `unknown action ${req.params.actionKey}`);
        }
      } catch (err) {
        if (err instanceof ShellInputError) throw new HttpError(400, err.message);
        throw err;
      }
    });

    router.get('/hubspot/crm-card', (req) => {
      verify(req);
      const c = findContact(this.deps.engine, { email: req.query.get('email'), phone: req.query.get('phone'), contactId: req.query.get('fsm_bridge_id') ?? undefined });
      if (!c) return json(200, { results: [], primaryAction: null, settingsAction: null, totalCount: 0 });
      const m = this.deps.engine.ledger.metrics(c.id);
      const jobs = this.deps.engine.ledger.jobsForContact(c.id).slice(-5).reverse();
      return json(200, {
        totalCount: 1 + jobs.length,
        results: [
          {
            objectId: 1,
            title: `${c.displayName} — FSM lifetime value`,
            properties: [
              { label: 'Lifetime value', dataType: 'CURRENCY', value: (m.lifetimeValueCents / 100).toFixed(2), currencyCode: 'USD' },
              { label: 'Completed jobs', dataType: 'NUMERIC', value: String(m.completedJobCount) },
              { label: 'Average ticket', dataType: 'CURRENCY', value: (m.averageTicketCents / 100).toFixed(2), currencyCode: 'USD' },
              { label: 'Outstanding', dataType: 'CURRENCY', value: (m.outstandingCents / 100).toFixed(2), currencyCode: 'USD' },
              { label: 'Last review request', dataType: m.lastReviewRequestAt ? 'DATETIME' : 'STRING', value: m.lastReviewRequestAt ? String(Date.parse(m.lastReviewRequestAt)) : 'Never' },
              { label: 'Linked FSM records', dataType: 'STRING', value: c.externalIds.map((k) => k.replace(/^ext:/, '')).join(', ') },
            ],
          },
          ...jobs.map((j, i) => ({
            objectId: 100 + i,
            title: `${j.source} · ${j.title ?? `Job ${j.number ?? j.externalId}`}`,
            properties: [
              { label: 'Status', dataType: 'STATUS', value: j.status, optionType: j.status === 'completed' ? 'SUCCESS' : j.status === 'cancelled' ? 'DANGER' : 'INFO' },
              { label: 'Total', dataType: 'CURRENCY', value: (j.totalCents / 100).toFixed(2), currencyCode: 'USD' },
              ...(j.completedAt ? [{ label: 'Completed', dataType: 'DATETIME', value: String(Date.parse(j.completedAt)) }] : []),
            ],
          })),
        ],
      });
    });

    router.post('/hubspot/setup/properties', async (req) => {
      const denied = requireToken(cfg.adminToken)(req);
      if (denied) return denied;
      const portal = this.resolvePortal(null);
      if (!portal) throw new HttpError(400, 'no HubSpot portal installed');
      const results: Array<{ name: string; ok: boolean; error?: string }> = [];
      try {
        await this.api(portal, 'POST', '/crm/v3/properties/contacts/groups', HUBSPOT_PROPERTY_GROUP);
        results.push({ name: HUBSPOT_PROPERTY_GROUP.name, ok: true });
      } catch (err) {
        results.push({ name: HUBSPOT_PROPERTY_GROUP.name, ok: err instanceof CrmHttpError && err.status === 409, error: (err as Error).message });
      }
      for (const p of HUBSPOT_PROPERTIES) {
        try {
          await this.api(portal, 'POST', '/crm/v3/properties/contacts', { ...p, groupName: HUBSPOT_PROPERTY_GROUP.name });
          results.push({ name: p.name, ok: true });
        } catch (err) {
          results.push({ name: p.name, ok: err instanceof CrmHttpError && err.status === 409, error: (err as Error).message });
        }
      }
      return json(200, { portal, results });
    });
  }

  actionDefinitions() {
    const base = this.deps.publicUrl.replace(/\/$/, '');
    return HUBSPOT_ACTIONS.map((a) => ({
      actionUrl: `${base}/hubspot/actions/${a.key}`,
      published: true,
      objectTypes: ['CONTACT'],
      inputFields: a.inputFields,
      outputFields: a.outputFields,
      labels: { en: a.labels },
    }));
  }

  manifest() {
    const base = this.deps.publicUrl.replace(/\/$/, '');
    return {
      crm: this.id,
      scopes: HUBSPOT_SCOPES,
      redirectUri: `${base}/hubspot/oauth/callback`,
      installUrl: `${base}/hubspot/oauth/install`,
      crmCard: { dataFetchUrl: `${base}/hubspot/crm-card`, objectTypes: [{ name: 'contacts', propertiesToSend: ['email', 'phone', 'fsm_bridge_id'] }] },
      workflowActions: this.actionDefinitions(),
      properties: HUBSPOT_PROPERTIES.map((p) => p.name),
      workflowEnrollment: 'Enroll on "FSM Last Trigger" (fsm_last_trigger) is any of … — e.g. review_request_ready',
    };
  }
}

class HubSpotAdapter implements CrmAdapter {
  readonly id = 'hubspot';
  readonly label = 'HubSpot';

  constructor(private readonly shell: HubSpotShell) {}

  isConnected(ctx: CrmContext): boolean {
    return Boolean(this.shell.resolvePortal(ctx.accountId));
  }

  private async findExisting(portal: string, contact: UnifiedContact): Promise<string | null> {
    const cached = this.shell.deps.engine.store.kvGet<string>(this.shell.mapKey(portal, contact.id));
    if (cached) return cached;
    const groups = [{ filters: [{ propertyName: 'fsm_bridge_id', operator: 'EQ', value: contact.id }] }];
    if (contact.email) groups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: contact.email }] });
    if (contact.phone) groups.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: contact.phone }] });
    const { json: res } = await this.shell.api<{ results?: Array<{ id: string }> }>(portal, 'POST', '/crm/v3/objects/contacts/search', {
      filterGroups: groups,
      properties: ['email', 'phone', 'fsm_bridge_id'],
      limit: 1,
    });
    return res.results?.[0]?.id ?? null;
  }

  async syncContact(contact: UnifiedContact, metrics: CustomerMetrics, _e: NormalizedEvent, ctx: CrmContext): Promise<CrmResult> {
    const portal = this.shell.resolvePortal(ctx.accountId)!;
    const properties = this.shell.contactProperties(contact, metrics);
    const existing = await this.findExisting(portal, contact);
    let id: string;
    let status: number;
    if (existing) {
      const r = await this.shell.api<{ id: string }>(portal, 'PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(existing)}`, { properties });
      id = existing;
      status = r.status;
    } else {
      const r = await this.shell.api<{ id: string }>(portal, 'POST', '/crm/v3/objects/contacts', { properties });
      id = String(r.json.id);
      status = r.status;
    }
    this.shell.deps.engine.store.kvSet(this.shell.mapKey(portal, contact.id), id);
    return { ok: true, action: 'contact.upsert', status, externalId: id, detail: existing ? 'updated' : 'created' };
  }

  async deliverTrigger(trigger: TriggerPayload, ctx: CrmContext): Promise<CrmResult> {
    const portal = this.shell.resolvePortal(ctx.accountId)!;
    const contactId = this.shell.deps.engine.store.kvGet<string>(this.shell.mapKey(portal, trigger.contact.id));
    if (!contactId) return { ok: false, action: `trigger.${trigger.key}`, detail: 'contact was not synced to HubSpot' };
    const details: string[] = [];
    const properties: Record<string, string> = { fsm_last_trigger: trigger.key, fsm_last_trigger_at: trigger.occurredAt };
    if (trigger.key === 'review_request_ready') {
      properties.fsm_review_requested_at = trigger.occurredAt;
      properties.fsm_review_channels = trigger.review?.channels.join(';') ?? '';
    }
    const { status } = await this.shell.api(portal, 'PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties });
    details.push('contact properties');

    const e = trigger.event.entity;
    if (trigger.key === 'estimate_approved' && e.kind === 'estimate') {
      const { json: deal } = await this.shell.api<{ id: string }>(portal, 'POST', '/crm/v3/objects/deals', {
        properties: {
          dealname: `${e.title ?? 'Estimate'} (${trigger.source} #${e.number ?? e.externalId})`,
          amount: String(e.totalCents / 100),
          pipeline: this.shell.config.dealPipeline ?? 'default',
          dealstage: this.shell.config.dealStageWon ?? 'closedwon',
          closedate: e.approvedAt ?? trigger.occurredAt,
        },
        // 3 = deal → contact (HUBSPOT_DEFINED)
        associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
      });
      details.push(`deal ${deal.id}`);
    }

    const templateId = this.shell.config.timelineTemplates?.[trigger.key];
    if (templateId) {
      await this.shell.api(portal, 'POST', '/integrators/timeline/v3/events', {
        eventTemplateId: templateId,
        objectId: contactId,
        id: trigger.id.replace(/[^\w-]/g, '-').slice(0, 100),
        timestamp: trigger.occurredAt,
        tokens: Object.fromEntries(Object.entries(trigger.fields).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)])),
      });
      details.push('timeline event');
    }
    return { ok: true, action: `trigger.${trigger.key}`, status, externalId: contactId, detail: details.join(' + ') };
  }
}

export function createHubSpotShell(deps: ShellDeps, config: HubSpotConfig = {}): HubSpotShell {
  return new HubSpotShell(deps, config);
}
