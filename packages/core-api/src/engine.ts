/**
 * The bridge engine: verify → describe → idempotency → hydrate → normalize → dedupe → ledger →
 * business rules (triggers + review gate) → fan-out to every connected CRM shell → delivery log.
 */
import { flattenTrigger, withRetry, type CrmAdapter, type CrmContext, type CrmResult, type RetryOptions } from './crm.js';
import { ContactResolver } from './dedupe.js';
import { redactHeaders, startDelivery, step, type CrmCallLog, type DeliveryRecord } from './delivery-log.js';
import { hydrateJobber, NORMALIZERS, type HydrationRequest } from './normalizers/index.js';
import { entityKey, RevenueLedger } from './revenue.js';
import { DEFAULT_REVIEW_SETTINGS, evaluateReviewGate, type ReviewGateSettings } from './review-gate.js';
import { verifySignature, type HeaderBag, type SignatureScheme } from './signatures.js';
import { BridgeStore } from './store.js';
import type {
  FsmSource,
  NormalizedCustomer,
  NormalizedEvent,
  NormalizedInvoice,
  NormalizedJob,
  ReviewDecision,
  TriggerKey,
  TriggerPayload,
  UnifiedContact,
} from './types.js';
import { sha256Hex } from './util.js';

export interface FsmConnection {
  source: FsmSource;
  webhookSecret: string;
  scheme?: SignatureScheme;
  /** Jobber only: OAuth access token used to hydrate thin webhooks over GraphQL. */
  accessToken?: string;
  graphqlEndpoint?: string;
}

export type Hydrator = (req: HydrationRequest) => Promise<unknown>;

export interface EngineOptions {
  store?: BridgeStore;
  connections?: Partial<Record<FsmSource, FsmConnection>>;
  adapters?: CrmAdapter[];
  reviewSettings?: Partial<ReviewGateSettings>;
  /** "Invoice Paid >= $X" trigger threshold, in cents. Default $500. */
  highValueThresholdCents?: number;
  retry?: Partial<RetryOptions>;
  hydrators?: Partial<Record<FsmSource, Hydrator>>;
  /** Reject unsigned webhooks (default true). Disable only for local development. */
  requireSignatures?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface IngestOptions {
  simulated?: boolean;
  /** Bypass signature check — only used for replays of deliveries that were already verified. */
  trusted?: boolean;
  replayOf?: string;
}

export type DeliveryListener = (record: DeliveryRecord) => void;

const MAX_LOGGED_BODY = 64 * 1024;

export class BridgeEngine {
  readonly store: BridgeStore;
  readonly contacts: ContactResolver;
  readonly ledger: RevenueLedger;
  readonly adapters: CrmAdapter[];
  readonly connections: Partial<Record<FsmSource, FsmConnection>>;
  reviewSettings: ReviewGateSettings;
  highValueThresholdCents: number;
  /** Pre-hydrated resources for sandbox (simulated) thin webhooks: `${source}:${kind}:${id}` → node. */
  readonly sandboxFixtures = new Map<string, unknown>();
  private readonly retry: RetryOptions;
  private readonly hydrators: Partial<Record<FsmSource, Hydrator>>;
  private readonly requireSignatures: boolean;
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => Date;
  private readonly listeners = new Set<DeliveryListener>();

  constructor(options: EngineOptions = {}) {
    this.store = options.store ?? new BridgeStore();
    this.contacts = new ContactResolver(this.store);
    this.ledger = new RevenueLedger(this.store);
    this.adapters = options.adapters ?? [];
    this.connections = options.connections ?? {};
    this.reviewSettings = { ...DEFAULT_REVIEW_SETTINGS, ...(options.reviewSettings ?? {}) };
    this.highValueThresholdCents = options.highValueThresholdCents ?? 50_000;
    this.retry = { attempts: options.retry?.attempts ?? 3, baseDelayMs: options.retry?.baseDelayMs ?? 250 };
    this.hydrators = options.hydrators ?? {};
    this.requireSignatures = options.requireSignatures ?? true;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => new Date());
  }

  addAdapter(adapter: CrmAdapter): void {
    if (!this.adapters.some((a) => a.id === adapter.id)) this.adapters.push(adapter);
  }

  onDelivery(listener: DeliveryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setConnection(connection: FsmConnection): void {
    this.connections[connection.source] = connection;
  }

  async ingest(source: FsmSource, rawBody: string, headers: HeaderBag = {}, options: IngestOptions = {}): Promise<DeliveryRecord> {
    const started = Date.now();
    const record = startDelivery(source, {
      simulated: options.simulated ?? false,
      replayOf: options.replayOf ?? null,
      request: { headers: redactHeaders(headers), body: null },
    });
    try {
      await this.process(source, rawBody, headers, options, record);
    } catch (err) {
      record.status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
      step(record, 'error', false, record.error);
    }
    record.completedAt = new Date().toISOString();
    record.durationMs = Date.now() - started;
    this.store.addDelivery(record);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        /* listeners must never break ingestion */
      }
    }
    return record;
  }

  private async process(source: FsmSource, rawBody: string, headers: HeaderBag, options: IngestOptions, record: DeliveryRecord) {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      record.status = 'rejected';
      record.error = 'body is not valid JSON';
      record.request.body = rawBody.slice(0, 2000);
      step(record, 'parse', false, record.error);
      return;
    }
    record.request.body = rawBody.length > MAX_LOGGED_BODY ? { truncated: true, preview: rawBody.slice(0, MAX_LOGGED_BODY) } : body;
    step(record, 'parse', true, `${rawBody.length} bytes`);

    // 1. Signature
    const connection = this.connections[source];
    if (options.trusted) {
      record.signature = 'skipped';
      step(record, 'signature', true, 'trusted replay');
    } else if (connection?.webhookSecret) {
      const result = verifySignature(source, connection.webhookSecret, rawBody, headers, {
        scheme: connection.scheme,
        now: Math.floor(this.now().getTime() / 1000),
      });
      record.signature = result.valid ? 'valid' : 'invalid';
      step(record, 'signature', result.valid, result.reason ?? 'HMAC verified');
      if (!result.valid) {
        record.status = 'rejected';
        record.error = `invalid signature: ${result.reason}`;
        return;
      }
    } else if (this.requireSignatures) {
      record.status = 'rejected';
      record.signature = 'invalid';
      record.error = `no webhook secret configured for ${source}`;
      step(record, 'signature', false, record.error);
      return;
    } else {
      step(record, 'signature', true, 'signature checks disabled');
    }

    // 2. Describe + idempotency
    const normalizer = NORMALIZERS[source];
    const descriptor = normalizer.describe(body);
    record.rawEventName = descriptor.rawEventName;
    record.accountId = descriptor.accountId;
    const idemKey = `${source}:${descriptor.deliveryId ?? sha256Hex(rawBody)}`;
    record.idempotencyKey = idemKey;
    const prior = this.store.processedDeliveries.get(idemKey);
    if (prior && !options.replayOf) {
      record.status = 'duplicate';
      step(record, 'idempotency', true, `already processed as ${prior}`);
      return;
    }
    step(record, 'describe', true, descriptor.rawEventName);

    // 3. Hydrate thin webhooks
    let hydrated: unknown;
    if (descriptor.hydrate) {
      hydrated = await this.hydrate(source, descriptor.hydrate);
      step(record, 'hydrate', true, `${descriptor.hydrate.kind} ${descriptor.hydrate.id}`);
    }

    // 4. Normalize
    const events = normalizer.normalizeWebhook(body, hydrated);
    if (!events.length) {
      record.status = 'ignored';
      step(record, 'normalize', true, `no mapping for ${descriptor.rawEventName}`);
      this.store.processedDeliveries.set(idemKey, record.id);
      return;
    }
    step(record, 'normalize', true, events.map((e) => e.type).join(', '));

    const ctx: CrmContext = { accountId: descriptor.accountId, simulated: record.simulated, deliveryId: record.id };
    for (const event of events) {
      record.events.push({ id: event.id, type: event.type, entityId: event.entity.externalId, kind: event.entity.kind });
      await this.handleEvent(event, record, ctx);
    }

    const failures = record.crm.filter((c) => !c.ok);
    if (failures.length) {
      record.status = failures.length === record.crm.length ? 'failed' : 'partial';
      record.error = failures.map((f) => `${f.target}/${f.action}: ${f.error}`).join('; ');
    } else {
      record.status = 'processed';
      this.store.processedDeliveries.set(idemKey, record.id);
    }
  }

  private async hydrate(source: FsmSource, req: HydrationRequest): Promise<unknown> {
    const fixture = this.sandboxFixtures.get(`${source}:${req.kind}:${req.id}`);
    if (fixture !== undefined) return fixture;
    const custom = this.hydrators[source];
    if (custom) return custom(req);
    const conn = this.connections[source];
    if (source === 'jobber' && conn?.accessToken) {
      return hydrateJobber(req.kind, req.id, {
        accessToken: conn.accessToken,
        endpoint: conn.graphqlEndpoint,
        fetchImpl: this.fetchImpl,
      });
    }
    throw new Error(`cannot hydrate ${source} ${req.kind} ${req.id}: no access token or hydrator configured`);
  }

  private resolveCustomer(event: NormalizedEvent): { customer: NormalizedCustomer | null; existing: UnifiedContact | undefined } {
    const e = event.entity;
    if (e.kind === 'customer') return { customer: e, existing: undefined };
    if (e.customer) return { customer: e.customer, existing: undefined };
    const existing = e.customerExternalId ? this.contacts.findByExternal(e.source, e.customerExternalId) : undefined;
    return { customer: null, existing };
  }

  private async handleEvent(event: NormalizedEvent, record: DeliveryRecord, ctx: CrmContext): Promise<void> {
    const { customer, existing } = this.resolveCustomer(event);
    let contact: UnifiedContact | undefined = existing;
    if (customer) {
      const r = this.contacts.resolve(customer);
      contact = r.contact;
      step(
        record,
        'dedupe',
        true,
        `${r.created ? 'created' : `matched by ${r.matchedBy}`} ${contact.id}${r.changed.length ? ` (updated ${r.changed.join(', ')})` : ''}${r.notes.length ? ` — ${r.notes.join('; ')}` : ''}`,
      );
    } else if (contact) {
      step(record, 'dedupe', true, `linked via ${event.source} customer ${event.entity.kind !== 'customer' ? event.entity.customerExternalId : ''} → ${contact.id}`);
    } else {
      step(record, 'dedupe', false, 'event carries no customer and no known customer id; ledger only');
    }
    if (!contact) return;
    record.contactId = contact.id;

    const e = event.entity;
    if (e.kind === 'job') this.ledger.recordJob(contact.id, e);
    else if (e.kind === 'invoice') this.ledger.recordInvoice(contact.id, e);
    else if (e.kind === 'estimate') this.ledger.recordEstimate(contact.id, e);
    const metrics = this.ledger.metrics(contact.id);
    step(record, 'ledger', true, `LTV $${(metrics.lifetimeValueCents / 100).toFixed(2)} · ${metrics.completedJobCount} completed job(s)`);

    // Business rules → triggers
    const triggerKeys: TriggerKey[] = [];
    if (event.type === 'estimate.approved') triggerKeys.push('estimate_approved');
    if (event.type === 'job.dispatched') triggerKeys.push('technician_dispatched');
    if (event.type === 'job.completed') triggerKeys.push('job_completed');
    if (event.type === 'invoice.paid' && e.kind === 'invoice') {
      triggerKeys.push('invoice_paid');
      if (e.totalCents >= this.highValueThresholdCents) triggerKeys.push('invoice_paid_high_value');
    }

    let review: ReviewDecision | undefined;
    let reviewJobKey: string | null = null;
    if (event.type === 'job.completed' || event.type === 'invoice.paid') {
      const job: NormalizedJob | undefined =
        e.kind === 'job' ? this.ledger.getJob(e.source, e.externalId) : e.kind === 'invoice' && e.jobExternalId ? this.ledger.getJob(e.source, e.jobExternalId) : undefined;
      reviewJobKey = job ? entityKey(job.source, job.externalId) : null;
      const jobInvoices: NormalizedInvoice[] = job ? this.ledger.invoicesForJob(job.source, job.externalId) : e.kind === 'invoice' ? [e] : [];
      review = evaluateReviewGate(
        {
          contact,
          job,
          jobInvoices,
          contactInvoices: this.ledger.invoicesForContact(contact.id),
          lastReviewRequestAt: this.store.reviewRequests.get(contact.id) ?? null,
          jobAlreadyReviewed: reviewJobKey ? this.store.reviewedJobs.has(reviewJobKey) : false,
          now: this.now(),
        },
        this.reviewSettings,
      );
      step(record, 'review-gate', true, `${review.eligible ? 'ELIGIBLE' : 'blocked'}: ${review.reasons.join('; ')}`);
      if (review.eligible) triggerKeys.push('review_request_ready');
    }

    const triggers: TriggerPayload[] = triggerKeys.map((key) => {
      const base = {
        key,
        id: key === 'review_request_ready' && reviewJobKey ? `${key}:${reviewJobKey}` : `${key}:${event.id}`,
        occurredAt: event.occurredAt,
        source: event.source,
        contact,
        metrics,
        event,
        ...(review && (key === 'review_request_ready' || key === 'job_completed' || key === 'invoice_paid') ? { review } : {}),
      };
      return { ...base, fields: flattenTrigger(base) };
    });

    // Fan-out to CRMs
    const connected = this.adapters.filter((a) => a.isConnected(ctx));
    if (!connected.length) step(record, 'crm', true, 'no CRM connected — normalized only');
    for (const adapter of connected) {
      await this.call(record, adapter.id, 'contact.upsert', () => adapter.syncContact(contact, metrics, event, ctx));
      for (const trigger of triggers) {
        const deliveredKey = `${trigger.id}@${adapter.id}`;
        if (this.store.firedTriggers.has(deliveredKey)) {
          record.triggers.push({ id: trigger.id, key: trigger.key, fired: false, reason: `already delivered to ${adapter.id}` });
          continue;
        }
        const ok = await this.call(record, adapter.id, `trigger.${trigger.key}`, () => adapter.deliverTrigger(trigger, ctx));
        if (ok) {
          this.store.firedTriggers.add(deliveredKey);
          this.store.touch();
        }
        record.triggers.push({ id: trigger.id, key: trigger.key, fired: ok, ...(ok ? {} : { reason: `delivery to ${adapter.id} failed` }) });
      }
    }
    if (!connected.length) for (const t of triggers) record.triggers.push({ id: t.id, key: t.key, fired: false, reason: 'no CRM connected' });

    // Only count a review as "requested" once at least one CRM accepted the trigger, so a failed
    // delivery can be retried/replayed without the cooldown blocking it.
    if (review?.eligible && record.triggers.some((t) => t.key === 'review_request_ready' && t.fired)) {
      this.store.reviewRequests.set(contact.id, this.now().toISOString());
      if (reviewJobKey) this.store.reviewedJobs.add(reviewJobKey);
      this.store.touch();
    }
  }

  private async call(record: DeliveryRecord, target: string, action: string, fn: () => Promise<CrmResult>): Promise<boolean> {
    const started = Date.now();
    const log: CrmCallLog = { target, action, ok: false, attempts: 0, durationMs: 0 };
    try {
      const { value, attempts } = await withRetry(() => fn(), this.retry);
      log.ok = value.ok;
      log.attempts = attempts;
      if (value.status !== undefined) log.status = value.status;
      if (value.externalId) log.externalId = value.externalId;
      if (value.detail) log.detail = value.detail;
      if (value.skipped) log.detail = `skipped${value.detail ? `: ${value.detail}` : ''}`;
      if (!value.ok) log.error = value.detail ?? 'adapter returned ok=false';
    } catch (err) {
      log.ok = false;
      log.attempts = (err as { attempts?: number }).attempts ?? this.retry.attempts;
      log.error = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number') log.status = status;
    }
    log.durationMs = Date.now() - started;
    record.crm.push(log);
    return log.ok;
  }

  /** Re-runs a stored delivery (e.g. after fixing CRM credentials). */
  async replay(deliveryId: string): Promise<DeliveryRecord> {
    const original = this.store.getDelivery(deliveryId);
    if (!original) throw new Error(`delivery ${deliveryId} not found`);
    if (original.signature === 'invalid') throw new Error('cannot replay a delivery that failed signature verification');
    const body = original.request.body;
    if (body && typeof body === 'object' && (body as { truncated?: boolean }).truncated) throw new Error('delivery body was truncated; cannot replay');
    return this.ingest(original.source, JSON.stringify(body), {}, { trusted: true, replayOf: original.id, simulated: original.simulated });
  }

  contactDetail(contactId: string) {
    const contact = this.store.contacts.get(contactId);
    if (!contact) return null;
    return {
      contact,
      metrics: this.ledger.metrics(contactId),
      jobs: this.ledger.jobsForContact(contactId),
      invoices: this.ledger.invoicesForContact(contactId),
      estimates: [...this.store.estimates.values()].filter((e) => e.contactId === contactId).map((e) => e.entity),
      deliveries: this.store.deliveries.filter((d) => d.contactId === contactId).slice(0, 50),
    };
  }

  listContacts(query: { q?: string; limit?: number } = {}) {
    const q = query.q?.toLowerCase().trim();
    return [...this.store.contacts.values()]
      .filter((c) => !q || [c.displayName, c.email, c.phone, ...c.externalIds].some((v) => v?.toLowerCase().includes(q)))
      .map((c) => ({ ...c, metrics: this.ledger.metrics(c.id) }))
      .sort((a, b) => b.metrics.lifetimeValueCents - a.metrics.lifetimeValueCents)
      .slice(0, query.limit ?? 200);
  }
}
