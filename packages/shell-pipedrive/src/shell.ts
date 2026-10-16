/**
 * Pipedrive Marketplace app shell.
 *
 * Surfaces:
 *   - OAuth:            GET /pipedrive/oauth/install → /pipedrive/oauth/callback (Basic client auth, api_domain)
 *   - Person sync:      search by email/phone (exact) → PUT or POST /v1/persons
 *   - Triggers:         estimate approved → won deal; dispatched → activity; completed/paid → notes;
 *                       review ready → "Send Google review request" activity
 *   - JSON panel:       GET /pipedrive/panel (app extension, Basic auth) — LTV & jobs on the person sidebar
 *   - Test action:      POST /pipedrive/actions/fire_test_event (app extension "custom modal"/automation)
 */
import {
  basicAuth,
  CrmHttpError,
  findContact,
  fireTestEvent,
  header,
  html,
  HttpError,
  json,
  parseBasicAuth,
  parseJson,
  requestJson,
  safeCompare,
  ShellInputError,
  signState,
  summarizeContact,
  TokenVault,
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

export interface PipedriveConfig {
  clientId?: string;
  clientSecret?: string;
  /** Personal API token (single company, no OAuth). */
  apiToken?: string;
  /** Company API base for apiToken mode, e.g. https://acme.pipedrive.com/api. */
  apiBase?: string;
  oauthBase?: string;
  /** Basic-auth credentials configured on the JSON panel app extension. */
  panelUser?: string;
  panelPassword?: string;
  /** Hash keys of person custom fields (Pipedrive custom fields are addressed by 40-char keys). */
  fieldKeys?: Partial<Record<'ltv' | 'completedJobs' | 'bridgeId' | 'leadSource', string>>;
  currency?: string;
}

const PANEL_ACCOUNT = 'default';

export class PipedriveShell implements MarketplaceShell {
  readonly id = 'pipedrive';
  readonly label = 'Pipedrive';
  readonly adapter: CrmAdapter;
  readonly vault: TokenVault;

  constructor(
    readonly deps: ShellDeps,
    readonly config: PipedriveConfig = {},
  ) {
    this.vault = new TokenVault(deps.engine.store, 'pipedrive');
    this.adapter = new PipedriveAdapter(this);
  }

  connected(): boolean {
    return Boolean(this.config.apiToken || this.vault.accounts().length);
  }

  private get oauthBase() {
    return (this.config.oauthBase ?? 'https://oauth.pipedrive.com').replace(/\/$/, '');
  }

  /** Returns `{ base, auth }` for the active company. */
  async credentials(): Promise<{ base: string; headers: Record<string, string>; query: string }> {
    if (this.config.apiToken) {
      return { base: (this.config.apiBase ?? 'https://api.pipedrive.com').replace(/\/$/, ''), headers: {}, query: `api_token=${encodeURIComponent(this.config.apiToken)}` };
    }
    const account = this.vault.accounts()[0];
    const tokens = account ? await this.vault.fresh(account, (t) => this.refresh(t)) : undefined;
    if (!tokens) throw new CrmHttpError('Pipedrive is not connected', 401, null);
    const base = (this.config.apiBase ?? tokens.meta?.apiDomain ?? 'https://api.pipedrive.com').replace(/\/$/, '');
    return { base, headers: { authorization: `Bearer ${tokens.accessToken}` }, query: '' };
  }

  private async refresh(t: OAuthTokens): Promise<OAuthTokens> {
    const { json: body } = await requestJson<Record<string, unknown>>({
      url: `${this.oauthBase}/oauth/token`,
      method: 'POST',
      form: true,
      headers: { authorization: basicAuth(this.config.clientId ?? '', this.config.clientSecret ?? '') },
      body: { grant_type: 'refresh_token', refresh_token: t.refreshToken ?? '' },
      fetchImpl: this.deps.fetchImpl,
    });
    return {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token ?? t.refreshToken),
      expiresAt: Date.now() + Number(body.expires_in ?? 3599) * 1000,
      meta: body.api_domain ? { apiDomain: String(body.api_domain) } : undefined,
    };
  }

  async api<T = { data?: unknown }>(method: string, path: string, body?: unknown) {
    const c = await this.credentials();
    const sep = path.includes('?') ? '&' : '?';
    return requestJson<T>({ url: `${c.base}${path}${c.query ? sep + c.query : ''}`, method, body, headers: c.headers, fetchImpl: this.deps.fetchImpl });
  }

  personBody(contact: UnifiedContact, metrics: CustomerMetrics): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: contact.displayName,
      ...(contact.emails.length ? { email: contact.emails.map((value, i) => ({ value, primary: i === 0, label: 'home' })) } : {}),
      ...(contact.phones.length ? { phone: contact.phones.map((value, i) => ({ value, primary: i === 0, label: i === 0 ? 'mobile' : 'other' })) } : {}),
    };
    const keys = this.config.fieldKeys ?? {};
    if (keys.ltv) body[keys.ltv] = metrics.lifetimeValueCents / 100;
    if (keys.completedJobs) body[keys.completedJobs] = metrics.completedJobCount;
    if (keys.bridgeId) body[keys.bridgeId] = contact.id;
    if (keys.leadSource && contact.leadSource) body[keys.leadSource] = contact.leadSource;
    return body;
  }

  mapKey(bridgeId: string) {
    return `pipedrive:person:${bridgeId}`;
  }

  registerRoutes(router: Router): void {
    const cfg = this.config;
    const base = this.deps.publicUrl.replace(/\/$/, '');
    const redirectUri = `${base}/pipedrive/oauth/callback`;

    router.get('/pipedrive/oauth/install', () => {
      if (!cfg.clientId) throw new HttpError(503, 'PIPEDRIVE_CLIENT_ID is not configured');
      const url = new URL(`${this.oauthBase}/oauth/authorize`);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', signState(this.deps.appSecret, { crm: 'pipedrive' }));
      return { status: 302, headers: { location: url.toString() } };
    });

    router.get('/pipedrive/oauth/callback', async (req) => {
      const code = req.query.get('code');
      if (!code) throw new HttpError(400, 'missing ?code');
      if (!verifyState(this.deps.appSecret, req.query.get('state'))) throw new HttpError(400, 'invalid OAuth state');
      const { json: body } = await requestJson<Record<string, unknown>>({
        url: `${this.oauthBase}/oauth/token`,
        method: 'POST',
        form: true,
        headers: { authorization: basicAuth(cfg.clientId ?? '', cfg.clientSecret ?? '') },
        body: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
        fetchImpl: this.deps.fetchImpl,
      });
      const apiDomain = body.api_domain ? String(body.api_domain) : 'https://api.pipedrive.com';
      const company = new URL(apiDomain).hostname.split('.')[0] ?? PANEL_ACCOUNT;
      this.vault.set(company, {
        accessToken: String(body.access_token),
        refreshToken: String(body.refresh_token ?? ''),
        expiresAt: Date.now() + Number(body.expires_in ?? 3599) * 1000,
        scope: body.scope ? String(body.scope) : undefined,
        meta: { apiDomain: `${apiDomain.replace(/\/$/, '')}/api` },
      });
      return html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:32px"><h1>FSM Bridge connected to Pipedrive</h1><p>Company <code>${company.replace(/[^\w-]/g, '')}</code> installed.</p></body>`);
    });

    const panelAuth = (req: BridgeRequest) => {
      if (!cfg.panelUser || !cfg.panelPassword) return;
      const creds = parseBasicAuth(header(req, 'authorization'));
      if (!creds || !safeCompare(creds.user, cfg.panelUser) || !safeCompare(creds.pass, cfg.panelPassword)) throw new HttpError(401, 'invalid panel credentials');
    };

    // JSON panel app extension: Pipedrive calls with ?resource=person&selectedIds=…&userId&companyId.
    router.get('/pipedrive/panel', async (req) => {
      panelAuth(req);
      const personId = req.query.get('selectedIds') ?? req.query.get('id');
      let email: string | undefined;
      let phone: string | undefined;
      if (personId && this.connected()) {
        try {
          const { json: p } = await this.api<{ data?: { email?: Array<{ value: string }>; phone?: Array<{ value: string }> } }>('GET', `/v1/persons/${encodeURIComponent(personId)}`);
          email = p.data?.email?.[0]?.value;
          phone = p.data?.phone?.[0]?.value;
        } catch {
          /* fall through to query params */
        }
      }
      const c = findContact(this.deps.engine, { email: email ?? req.query.get('email'), phone: phone ?? req.query.get('phone') });
      if (!c) return json(200, { data: [] });
      const m = this.deps.engine.ledger.metrics(c.id);
      const currency = cfg.currency ?? 'USD';
      return json(200, {
        data: [
          {
            id: c.id,
            header: `${c.displayName} · FSM`,
            lifetime_value: { code: currency, value: m.lifetimeValueCents / 100 },
            average_ticket: { code: currency, value: m.averageTicketCents / 100 },
            outstanding: { code: currency, value: m.outstandingCents / 100 },
            completed_jobs: m.completedJobCount,
            last_job: m.lastJobAt,
            last_review_request: m.lastReviewRequestAt ?? 'never',
            fsm_records: c.externalIds.map((k) => k.replace(/^ext:/, '')).join(', '),
          },
        ],
      });
    });

    router.post('/pipedrive/actions/fire_test_event', async (req) => {
      panelAuth(req);
      try {
        const { delivery } = await fireTestEvent(this.deps.engine, parseJson(req));
        return json(200, { success: true, data: { delivery_id: delivery.id, status: delivery.status, triggers: delivery.triggers.filter((t) => t.fired).map((t) => t.key) } });
      } catch (err) {
        if (err instanceof ShellInputError) throw new HttpError(400, err.message);
        throw err;
      }
    });

    router.get('/pipedrive/actions/lookup', (req) => {
      panelAuth(req);
      const c = findContact(this.deps.engine, { email: req.query.get('email'), phone: req.query.get('phone') });
      return json(200, { success: true, data: summarizeContact(c, c ? this.deps.engine.ledger.metrics(c.id) : undefined) });
    });

    // Pipedrive calls this when the app is uninstalled (configured as the app's uninstall callback).
    router.delete('/pipedrive/oauth/uninstall', (req) => {
      const creds = parseBasicAuth(header(req, 'authorization'));
      if (!cfg.clientId || !creds || !safeCompare(creds.user, cfg.clientId) || !safeCompare(creds.pass, cfg.clientSecret ?? '')) throw new HttpError(401, 'invalid client credentials');
      for (const a of this.vault.accounts()) this.vault.delete(a);
      return json(200, { ok: true });
    });
  }

  manifest() {
    const base = this.deps.publicUrl.replace(/\/$/, '');
    return {
      crm: this.id,
      callbackUrl: `${base}/pipedrive/oauth/callback`,
      installUrl: `${base}/pipedrive/oauth/install`,
      scopes: ['base', 'contacts:full', 'deals:full', 'activities:full'],
      appExtensions: [
        { type: 'json_panel', name: 'FSM lifetime value', location: 'person_details', dataUrl: `${base}/pipedrive/panel`, auth: 'basic' },
      ],
      actions: [`${base}/pipedrive/actions/fire_test_event`, `${base}/pipedrive/actions/lookup`],
      triggerMapping: {
        estimate_approved: 'won deal linked to person',
        technician_dispatched: 'activity (type: meeting) due at scheduled start',
        job_completed: 'note on person',
        invoice_paid: 'note on person',
        invoice_paid_high_value: 'note on person (high value)',
        review_request_ready: 'activity: "Send Google review request" (type: task)',
      },
    };
  }
}

class PipedriveAdapter implements CrmAdapter {
  readonly id = 'pipedrive';
  readonly label = 'Pipedrive';

  constructor(private readonly shell: PipedriveShell) {}

  isConnected(_ctx: CrmContext): boolean {
    return this.shell.connected();
  }

  private async search(term: string, field: 'email' | 'phone'): Promise<number | null> {
    const { json: res } = await this.shell.api<{ data?: { items?: Array<{ item: { id: number } }> } }>(
      'GET',
      `/v1/persons/search?term=${encodeURIComponent(term)}&fields=${field}&exact_match=true&limit=1`,
    );
    return res.data?.items?.[0]?.item.id ?? null;
  }

  async syncContact(contact: UnifiedContact, metrics: CustomerMetrics, _e: NormalizedEvent, _ctx: CrmContext): Promise<CrmResult> {
    const store = this.shell.deps.engine.store;
    let personId = store.kvGet<number>(this.shell.mapKey(contact.id)) ?? null;
    if (!personId && contact.email) personId = await this.search(contact.email, 'email');
    if (!personId && contact.phone) personId = await this.search(contact.phone, 'phone');
    const body = this.shell.personBody(contact, metrics);
    let status: number;
    if (personId) {
      status = (await this.shell.api('PUT', `/v1/persons/${personId}`, body)).status;
    } else {
      const r = await this.shell.api<{ data?: { id: number } }>('POST', '/v1/persons', body);
      status = r.status;
      personId = r.json.data?.id ?? null;
      if (!personId) throw new CrmHttpError('Pipedrive did not return a person id', r.status, r.json);
    }
    store.kvSet(this.shell.mapKey(contact.id), personId);
    return { ok: true, action: 'contact.upsert', status, externalId: String(personId) };
  }

  async deliverTrigger(trigger: TriggerPayload, _ctx: CrmContext): Promise<CrmResult> {
    const personId = this.shell.deps.engine.store.kvGet<number>(this.shell.mapKey(trigger.contact.id));
    if (!personId) return { ok: false, action: `trigger.${trigger.key}`, detail: 'person was not synced to Pipedrive' };
    const f = trigger.fields;
    const e = trigger.event.entity;
    const currency = this.shell.config.currency ?? 'USD';
    switch (trigger.key) {
      case 'estimate_approved': {
        const r = await this.shell.api<{ data?: { id: number } }>('POST', '/v1/deals', {
          title: `${String(f.estimate_title ?? 'Approved estimate')} (${trigger.source})`,
          value: Number(f.estimate_total ?? 0),
          currency,
          person_id: personId,
          status: 'won',
        });
        return { ok: true, action: 'trigger.estimate_approved', status: r.status, externalId: String(r.json.data?.id ?? ''), detail: 'won deal' };
      }
      case 'technician_dispatched': {
        const due = (e.kind === 'job' ? (e.scheduledStart ?? e.dispatchedAt) : null) ?? trigger.occurredAt;
        const r = await this.shell.api('POST', '/v1/activities', {
          subject: `Technician dispatched: ${String(f.technician_names ?? 'crew')} — ${String(f.job_title ?? 'job')}`,
          type: 'meeting',
          person_id: personId,
          due_date: due.slice(0, 10),
          due_time: due.slice(11, 16),
          note: `FSM: ${trigger.source} job ${String(f.job_number ?? f.job_id ?? '')}`,
        });
        return { ok: true, action: 'trigger.technician_dispatched', status: r.status, detail: 'activity' };
      }
      case 'review_request_ready': {
        const r = await this.shell.api('POST', '/v1/activities', {
          subject: `Send Google review request (${trigger.review?.channels.join(' + ') || 'sms'})`,
          type: 'task',
          person_id: personId,
          due_date: new Date(Date.parse(trigger.occurredAt) + (trigger.review?.delayMinutes ?? 0) * 60_000).toISOString().slice(0, 10),
          note: `Job ${String(f.job_id ?? '')} completed & paid. LTV $${String(f.lifetime_value)}.`,
        });
        return { ok: true, action: 'trigger.review_request_ready', status: r.status, detail: 'review task' };
      }
      default: {
        const lines = [
          `<b>${trigger.key.replace(/_/g, ' ')}</b> via ${trigger.source}`,
          f.job_title ? `Job: ${String(f.job_title)}` : null,
          f.invoice_total !== undefined && f.invoice_total !== null ? `Invoice: $${String(f.invoice_total)} (paid $${String(f.invoice_amount_paid)})` : null,
          `Lifetime value: $${String(f.lifetime_value)} · ${String(f.completed_jobs)} completed job(s)`,
        ].filter(Boolean);
        const r = await this.shell.api('POST', '/v1/notes', { content: lines.join('<br>'), person_id: personId });
        return { ok: true, action: `trigger.${trigger.key}`, status: r.status, detail: 'note' };
      }
    }
  }
}

export function createPipedriveShell(deps: ShellDeps, config: PipedriveConfig = {}): PipedriveShell {
  return new PipedriveShell(deps, config);
}
