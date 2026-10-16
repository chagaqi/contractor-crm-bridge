/**
 * monday.com apps-framework shell.
 *
 * Surfaces:
 *   - Board sync:              customer → item on a "FSM Customers" board (find by bridge-id column, else create)
 *   - Integration recipes:     custom trigger blocks (subscribe/unsubscribe) + custom action blocks
 *                              "When FSM {trigger} happens, create an item / notify someone …"
 *                              Requests from monday carry an HS256 JWT signed with the app Signing Secret.
 *   - OAuth:                   GET /monday/oauth/install → /monday/oauth/callback
 */
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
  ShellInputError,
  signState,
  summarizeContact,
  TokenVault,
  TRIGGER_KEYS,
  TRIGGER_LABELS,
  verifyJwt,
  verifyState,
  type BridgeRequest,
  type CrmAdapter,
  type CrmContext,
  type CrmResult,
  type CustomerMetrics,
  type MarketplaceShell,
  type NormalizedEvent,
  type Router,
  type ShellDeps,
  type TriggerKey,
  type TriggerPayload,
  type UnifiedContact,
} from '@ccb/core-api';

export const MONDAY_API_VERSION = '2024-10';

export interface MondayColumns {
  bridgeId: string;
  phone: string;
  email: string;
  ltv: string;
  jobs: string;
  status: string;
  sources: string;
}

export const DEFAULT_MONDAY_COLUMNS: MondayColumns = {
  bridgeId: 'text_bridge_id',
  phone: 'phone',
  email: 'email',
  ltv: 'numbers_ltv',
  jobs: 'numbers_jobs',
  status: 'status',
  sources: 'text_sources',
};

export interface MondayConfig {
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  apiToken?: string;
  boardId?: string;
  columns?: Partial<MondayColumns>;
  apiUrl?: string;
  authBase?: string;
}

export interface MondaySubscription {
  webhookId: string;
  subscriptionId: string | null;
  key: TriggerKey;
  webhookUrl: string;
  recipeId: string | null;
  accountId: string | null;
  createdAt: string;
}

export const MONDAY_STATUS_LABELS: Record<TriggerKey, string> = {
  estimate_approved: 'Estimate approved',
  technician_dispatched: 'Tech dispatched',
  job_completed: 'Job completed',
  invoice_paid: 'Paid',
  invoice_paid_high_value: 'Paid ($500+)',
  review_request_ready: 'Ask for review',
};

export class MondayShell implements MarketplaceShell {
  readonly id = 'monday';
  readonly label = 'monday.com';
  readonly adapter: CrmAdapter;
  readonly vault: TokenVault;
  readonly columns: MondayColumns;

  constructor(
    readonly deps: ShellDeps,
    readonly config: MondayConfig = {},
  ) {
    this.vault = new TokenVault(deps.engine.store, 'monday');
    this.columns = { ...DEFAULT_MONDAY_COLUMNS, ...(config.columns ?? {}) };
    this.adapter = new MondayAdapter(this);
  }

  token(): string | null {
    if (this.config.apiToken) return this.config.apiToken;
    const account = this.vault.accounts()[0];
    return account ? (this.vault.get(account)?.accessToken ?? null) : null;
  }

  subscriptions(key?: TriggerKey): MondaySubscription[] {
    return this.deps.engine.store
      .kvEntries<MondaySubscription>('monday:sub:')
      .map(([, v]) => v)
      .filter((s) => !key || s.key === key);
  }

  async gql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>, token = this.token()): Promise<T> {
    if (!token) throw new CrmHttpError('monday.com is not connected', 401, null);
    const { json: res } = await requestJson<{ data?: T; errors?: Array<{ message: string }>; error_message?: string }>({
      url: this.config.apiUrl ?? 'https://api.monday.com/v2',
      method: 'POST',
      headers: { authorization: token, 'api-version': MONDAY_API_VERSION },
      body: { query, variables },
      fetchImpl: this.deps.fetchImpl,
    });
    if (res.errors?.length || res.error_message) throw new CrmHttpError(`monday GraphQL: ${res.errors?.[0]?.message ?? res.error_message}`, 400, res);
    return res.data as T;
  }

  columnValues(contact: UnifiedContact, metrics: CustomerMetrics, status?: string): Record<string, unknown> {
    const c = this.columns;
    const values: Record<string, unknown> = {
      [c.bridgeId]: contact.id,
      [c.ltv]: String(metrics.lifetimeValueCents / 100),
      [c.jobs]: String(metrics.completedJobCount),
      [c.sources]: [...new Set(contact.externalIds.map((k) => k.split(':')[1]))].join(', '),
    };
    if (contact.phone) values[c.phone] = { phone: contact.phone, countryShortName: contact.phone.startsWith('+1') ? 'US' : '' };
    if (contact.email) values[c.email] = { email: contact.email, text: contact.email };
    if (status) values[c.status] = { label: status };
    return values;
  }

  /** Verifies the `Authorization` JWT monday sends with integration requests. */
  verifyMondayRequest(req: BridgeRequest): Record<string, unknown> {
    const secret = this.config.signingSecret;
    if (!secret) return {};
    const claims = verifyJwt(header(req, 'authorization'), secret);
    if (!claims) throw new HttpError(401, 'invalid monday authorization JWT');
    return claims;
  }

  registerRoutes(router: Router): void {
    const cfg = this.config;
    const base = this.deps.publicUrl.replace(/\/$/, '');
    const redirectUri = `${base}/monday/oauth/callback`;
    const authBase = (cfg.authBase ?? 'https://auth.monday.com').replace(/\/$/, '');

    router.get('/monday/oauth/install', () => {
      if (!cfg.clientId) throw new HttpError(503, 'MONDAY_CLIENT_ID is not configured');
      const url = new URL(`${authBase}/oauth2/authorize`);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', signState(this.deps.appSecret, { crm: 'monday' }));
      return { status: 302, headers: { location: url.toString() } };
    });

    router.get('/monday/oauth/callback', async (req) => {
      const code = req.query.get('code');
      if (!code) throw new HttpError(400, 'missing ?code');
      if (!verifyState(this.deps.appSecret, req.query.get('state'))) throw new HttpError(400, 'invalid OAuth state');
      const { json: body } = await requestJson<Record<string, unknown>>({
        url: `${authBase}/oauth2/token`,
        method: 'POST',
        body: { client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri },
        fetchImpl: this.deps.fetchImpl,
      });
      const token = String(body.access_token);
      let accountId = 'default';
      try {
        const me = await this.gql<{ me?: { account?: { id?: string } } }>('query { me { account { id } } }', {}, token);
        accountId = String(me.me?.account?.id ?? accountId);
      } catch {
        /* keep default */
      }
      this.vault.set(accountId, { accessToken: token, scope: body.scope ? String(body.scope) : undefined, meta: { accountId } });
      return html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:32px"><h1>FSM Bridge connected to monday.com</h1><p>Account <code>${accountId.replace(/[^\w-]/g, '')}</code> installed.</p></body>`);
    });

    // Custom trigger block subscribe/unsubscribe (one subscribe URL per trigger key).
    router.post('/monday/triggers/:key/subscribe', (req) => {
      const claims = this.verifyMondayRequest(req);
      const key = req.params.key as TriggerKey;
      if (!TRIGGER_KEYS.includes(key)) throw new HttpError(404, `unknown trigger ${key}`);
      const { payload } = parseJson<{ payload?: { webhookUrl?: string; subscriptionId?: string | number; recipeId?: string | number } }>(req);
      if (!payload?.webhookUrl) throw new HttpError(400, 'payload.webhookUrl is required');
      const webhookId = `mwh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const sub: MondaySubscription = {
        webhookId,
        subscriptionId: payload.subscriptionId !== undefined ? String(payload.subscriptionId) : null,
        key,
        webhookUrl: payload.webhookUrl,
        recipeId: payload.recipeId !== undefined ? String(payload.recipeId) : null,
        accountId: claims.accountId !== undefined ? String(claims.accountId) : null,
        createdAt: new Date().toISOString(),
      };
      this.deps.engine.store.kvSet(`monday:sub:${webhookId}`, sub);
      return json(200, { webhookId });
    });

    router.post('/monday/triggers/unsubscribe', (req) => {
      this.verifyMondayRequest(req);
      const { payload } = parseJson<{ payload?: { webhookId?: string } }>(req);
      if (!payload?.webhookId) throw new HttpError(400, 'payload.webhookId is required');
      this.deps.engine.store.kvDelete(`monday:sub:${payload.webhookId}`);
      return json(200, { ok: true });
    });

    // Custom action blocks.
    router.post('/monday/actions/:actionKey', async (req) => {
      const claims = this.verifyMondayRequest(req);
      const { payload } = parseJson<{ payload?: { inboundFieldValues?: Record<string, unknown>; inputFields?: Record<string, unknown> } }>(req);
      const inputs = { ...(payload?.inputFields ?? {}), ...(payload?.inboundFieldValues ?? {}) };
      try {
        switch (req.params.actionKey) {
          case 'fire_test_event': {
            const { delivery } = await fireTestEvent(this.deps.engine, inputs);
            return json(200, { delivery_id: delivery.id, status: delivery.status });
          }
          case 'sync_ltv_to_item': {
            const itemId = inputs.itemId ?? inputs.item_id;
            const boardId = inputs.boardId ?? inputs.board_id ?? cfg.boardId;
            if (!itemId || !boardId) throw new ShellInputError('itemId and boardId are required');
            const c = findContact(this.deps.engine, { email: inputs.email, phone: inputs.phone });
            const s = summarizeContact(c, c ? this.deps.engine.ledger.metrics(c.id) : undefined);
            const token = typeof claims.shortLivedToken === 'string' ? claims.shortLivedToken : this.token();
            await this.gql(
              'mutation ($board: ID!, $item: ID!, $vals: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals) { id } }',
              { board: String(boardId), item: String(itemId), vals: JSON.stringify({ [this.columns.ltv]: String(s.lifetime_value), [this.columns.jobs]: String(s.completed_jobs) }) },
              token,
            );
            return json(200, { found: s.found });
          }
          default:
            throw new HttpError(404, `unknown action ${req.params.actionKey}`);
        }
      } catch (err) {
        if (err instanceof ShellInputError) throw new HttpError(400, err.message);
        throw err;
      }
    });

    // Remote options for the "FSM" dropdown field in recipe sentences.
    router.post('/monday/fields/sources', () =>
      json(200, ['jobber', 'housecallpro', 'servicetitan', 'fieldedge', 'buildertrend'].map((value) => ({ value, title: value }))),
    );
  }

  manifest() {
    const base = this.deps.publicUrl.replace(/\/$/, '');
    return {
      crm: this.id,
      redirectUri: `${base}/monday/oauth/callback`,
      installUrl: `${base}/monday/oauth/install`,
      scopes: ['boards:read', 'boards:write', 'updates:write', 'me:read'],
      boardColumns: this.columns,
      triggers: TRIGGER_KEYS.map((key) => ({
        key,
        name: TRIGGER_LABELS[key]!.name,
        subscribeUrl: `${base}/monday/triggers/${key}/subscribe`,
        unsubscribeUrl: `${base}/monday/triggers/unsubscribe`,
        outputFields: ['contact_name', 'contact_phone', 'contact_email', 'fsm_source', 'job_title', 'invoice_total', 'lifetime_value', 'review_channels'],
      })),
      actions: [
        { key: 'fire_test_event', runUrl: `${base}/monday/actions/fire_test_event` },
        { key: 'sync_ltv_to_item', runUrl: `${base}/monday/actions/sync_ltv_to_item` },
      ],
      recipes: [
        'When FSM Job Completed, create an item in this board',
        'When FSM Review Request Ready, notify someone',
        'When FSM Invoice Paid ($500+), move item to group',
      ],
    };
  }
}

class MondayAdapter implements CrmAdapter {
  readonly id = 'monday';
  readonly label = 'monday.com';

  constructor(private readonly shell: MondayShell) {}

  isConnected(_ctx: CrmContext): boolean {
    return Boolean((this.shell.token() && this.shell.config.boardId) || this.shell.subscriptions().length);
  }

  private mapKey(bridgeId: string) {
    return `monday:item:${this.shell.config.boardId}:${bridgeId}`;
  }

  async syncContact(contact: UnifiedContact, metrics: CustomerMetrics, _e: NormalizedEvent, _ctx: CrmContext): Promise<CrmResult> {
    const boardId = this.shell.config.boardId;
    if (!boardId || !this.shell.token()) return { ok: true, action: 'contact.upsert', skipped: true, detail: 'no board configured (recipe-only mode)' };
    const store = this.shell.deps.engine.store;
    let itemId = store.kvGet<string>(this.mapKey(contact.id)) ?? null;
    if (!itemId) {
      const found = await this.shell.gql<{ items_page_by_column_values?: { items?: Array<{ id: string }> } }>(
        'query ($board: ID!, $col: String!, $val: String!) { items_page_by_column_values(board_id: $board, limit: 1, columns: [{column_id: $col, column_values: [$val]}]) { items { id } } }',
        { board: boardId, col: this.shell.columns.bridgeId, val: contact.id },
      );
      itemId = found.items_page_by_column_values?.items?.[0]?.id ?? null;
    }
    const vals = JSON.stringify(this.shell.columnValues(contact, metrics));
    if (itemId) {
      await this.shell.gql('mutation ($board: ID!, $item: ID!, $vals: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals) { id } }', {
        board: boardId,
        item: itemId,
        vals,
      });
    } else {
      const created = await this.shell.gql<{ create_item?: { id: string } }>(
        'mutation ($board: ID!, $name: String!, $vals: JSON!) { create_item(board_id: $board, item_name: $name, column_values: $vals, create_labels_if_missing: true) { id } }',
        { board: boardId, name: contact.displayName, vals },
      );
      itemId = created.create_item?.id ?? null;
      if (!itemId) throw new CrmHttpError('monday did not return an item id', 502, created);
    }
    store.kvSet(this.mapKey(contact.id), itemId);
    return { ok: true, action: 'contact.upsert', externalId: itemId, detail: 'board item' };
  }

  async deliverTrigger(trigger: TriggerPayload, _ctx: CrmContext): Promise<CrmResult> {
    const details: string[] = [];
    const boardId = this.shell.config.boardId;
    const itemId = boardId ? this.shell.deps.engine.store.kvGet<string>(this.mapKey(trigger.contact.id)) : undefined;
    if (boardId && itemId) {
      await this.shell.gql('mutation ($board: ID!, $item: ID!, $vals: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $vals, create_labels_if_missing: true) { id } }', {
        board: boardId,
        item: itemId,
        vals: JSON.stringify({ [this.shell.columns.status]: { label: MONDAY_STATUS_LABELS[trigger.key] } }),
      });
      await this.shell.gql('mutation ($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }', {
        item: itemId,
        body: `<b>${MONDAY_STATUS_LABELS[trigger.key]}</b> · ${trigger.source} · LTV $${String(trigger.fields.lifetime_value)}`,
      });
      details.push('item status + update');
    }
    const subs = this.shell.subscriptions(trigger.key);
    for (const sub of subs) {
      await requestJson({
        url: sub.webhookUrl,
        method: 'POST',
        headers: { authorization: this.shell.config.signingSecret ?? '' },
        body: { trigger: { outputFields: trigger.fields } },
        fetchImpl: this.shell.deps.fetchImpl,
      });
    }
    if (subs.length) details.push(`${subs.length} recipe subscription(s)`);
    if (!details.length) return { ok: true, action: `trigger.${trigger.key}`, skipped: true, detail: 'no board item or recipe subscriptions' };
    return { ok: true, action: `trigger.${trigger.key}`, externalId: itemId, detail: details.join(' + ') };
  }
}

export function createMondayShell(deps: ShellDeps, config: MondayConfig = {}): MondayShell {
  return new MondayShell(deps, config);
}
