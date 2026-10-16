/**
 * Contract every CRM marketplace shell implements. The engine never knows which CRM it talks to.
 */
import type { CustomerMetrics, NormalizedEvent, TriggerPayload, UnifiedContact } from './types.js';
import { formatNational } from './phone.js';

export interface CrmResult {
  ok: boolean;
  action: string;
  status?: number;
  /** Id of the record in the CRM (contact id, deal id ...). */
  externalId?: string;
  detail?: string;
  /** Set when the adapter decided not to act (e.g. no subscribers for a trigger). */
  skipped?: boolean;
}

export interface CrmContext {
  /** FSM account id the event came from — shells map this to a CRM location/portal/account. */
  accountId: string | null;
  simulated: boolean;
  deliveryId: string;
}

export interface CrmAdapter {
  readonly id: string;
  readonly label: string;
  /** Whether the shell has credentials (or a test sink) configured. Unconnected shells are skipped. */
  isConnected(ctx: CrmContext): boolean;
  syncContact(contact: UnifiedContact, metrics: CustomerMetrics, event: NormalizedEvent, ctx: CrmContext): Promise<CrmResult>;
  deliverTrigger(trigger: TriggerPayload, ctx: CrmContext): Promise<CrmResult>;
}

export class CrmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'CrmHttpError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface JsonRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send `body` as application/x-www-form-urlencoded instead of JSON. */
  form?: boolean;
  fetchImpl?: typeof fetch;
}

export interface JsonResponse<T = unknown> {
  status: number;
  json: T;
}

/** Minimal JSON HTTP client used by all shells. Throws CrmHttpError on non-2xx. */
export async function requestJson<T = unknown>(req: JsonRequest): Promise<JsonResponse<T>> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.body !== undefined) {
    if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.body as Record<string, string>).toString();
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
  }
  const res = await fetchImpl(req.url, { method: req.method ?? (body ? 'POST' : 'GET'), headers, body });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!res.ok) {
    const msg = typeof json === 'object' && json !== null ? JSON.stringify(json).slice(0, 300) : String(json).slice(0, 300);
    throw new CrmHttpError(`${req.method ?? 'GET'} ${req.url} → HTTP ${res.status}: ${msg}`, res.status, json);
  }
  return { status: res.status, json: json as T };
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<{ value: T; attempts: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, opts.attempts); attempt += 1) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      lastError = err;
      const retryable = !(err instanceof CrmHttpError) || err.retryable;
      if (!retryable || attempt >= opts.attempts) {
        (err as { attempts?: number }).attempts = attempt;
        throw err;
      }
      if (opts.baseDelayMs > 0) await new Promise((r) => setTimeout(r, opts.baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

const dollars = (cents: number | null | undefined) => (typeof cents === 'number' ? Math.round(cents) / 100 : null);

/** Flat, primitive-only field map that workflow builders (GHL, monday, Make, HubSpot) can map directly. */
export function flattenTrigger(t: Omit<TriggerPayload, 'fields'>): TriggerPayload['fields'] {
  const e = t.event.entity;
  const fields: TriggerPayload['fields'] = {
    trigger: t.key,
    trigger_id: t.id,
    occurred_at: t.occurredAt,
    fsm_source: t.source,
    fsm_event: t.event.type,
    fsm_account_id: t.event.accountId,
    contact_id: t.contact.id,
    contact_name: t.contact.displayName,
    contact_first_name: t.contact.firstName,
    contact_last_name: t.contact.lastName,
    contact_company: t.contact.companyName,
    contact_phone: t.contact.phone,
    contact_phone_national: formatNational(t.contact.phone),
    contact_email: t.contact.email,
    contact_city: t.contact.address?.city ?? null,
    contact_lead_source: t.contact.leadSource,
    lifetime_value: dollars(t.metrics.lifetimeValueCents),
    completed_jobs: t.metrics.completedJobCount,
    average_ticket: dollars(t.metrics.averageTicketCents),
    outstanding_balance: dollars(t.metrics.outstandingCents),
    entity_kind: e.kind,
    entity_id: e.externalId,
  };
  if (e.kind === 'job') {
    Object.assign(fields, {
      job_id: e.externalId,
      job_number: e.number,
      job_title: e.title,
      job_status: e.status,
      job_total: dollars(e.totalCents),
      technician_names: e.technicians.map((x) => x.name).join(', ') || null,
      scheduled_start: e.scheduledStart,
      completed_at: e.completedAt,
    });
  } else if (e.kind === 'invoice') {
    Object.assign(fields, {
      invoice_id: e.externalId,
      invoice_number: e.number,
      invoice_status: e.status,
      invoice_total: dollars(e.totalCents),
      invoice_amount_paid: dollars(e.amountPaidCents),
      invoice_balance: dollars(e.balanceCents),
      job_id: e.jobExternalId,
      paid_at: e.paidAt,
    });
  } else if (e.kind === 'estimate') {
    Object.assign(fields, {
      estimate_id: e.externalId,
      estimate_number: e.number,
      estimate_title: e.title,
      estimate_status: e.status,
      estimate_total: dollars(e.totalCents),
      approved_at: e.approvedAt,
      job_id: e.jobExternalId,
    });
  }
  if (t.review) {
    fields.review_eligible = t.review.eligible;
    fields.review_channels = t.review.channels.join(',') || null;
    fields.review_delay_minutes = t.review.delayMinutes;
  }
  return fields;
}

/** A test/sink adapter that records everything it receives — used by the sandbox and tests. */
export class RecordingCrmAdapter implements CrmAdapter {
  readonly contacts: Array<{ contact: UnifiedContact; metrics: CustomerMetrics }> = [];
  readonly triggers: TriggerPayload[] = [];
  failNext = 0;

  constructor(
    readonly id = 'recorder',
    readonly label = 'Recording sink',
  ) {}

  isConnected(): boolean {
    return true;
  }

  async syncContact(contact: UnifiedContact, metrics: CustomerMetrics): Promise<CrmResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new CrmHttpError('simulated outage', 503, null);
    }
    this.contacts.push({ contact: structuredClone(contact), metrics: { ...metrics } });
    return { ok: true, action: 'contact.upsert', externalId: contact.id };
  }

  async deliverTrigger(trigger: TriggerPayload): Promise<CrmResult> {
    this.triggers.push(structuredClone(trigger));
    return { ok: true, action: `trigger.${trigger.key}` };
  }
}

export interface InboxEntry {
  at: string;
  deliveryId: string;
  kind: 'contact' | 'trigger';
  key: string;
  fields: Record<string, unknown>;
}

/**
 * Built-in sandbox CRM: receives *only simulated* deliveries and keeps the last N payloads so the
 * playground can show exactly what each CRM workflow would receive — even before any CRM is connected.
 */
export class SandboxInboxAdapter implements CrmAdapter {
  readonly id = 'sandbox';
  readonly label = 'Sandbox CRM inbox';
  readonly entries: InboxEntry[] = [];

  constructor(private readonly limit = 200) {}

  isConnected(ctx: CrmContext): boolean {
    return ctx.simulated;
  }

  private push(entry: InboxEntry) {
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
  }

  async syncContact(contact: UnifiedContact, metrics: CustomerMetrics, _event: NormalizedEvent, ctx: CrmContext): Promise<CrmResult> {
    this.push({
      at: new Date().toISOString(),
      deliveryId: ctx.deliveryId,
      kind: 'contact',
      key: 'contact.upsert',
      fields: { contact_id: contact.id, name: contact.displayName, phone: contact.phone, email: contact.email, lifetime_value: metrics.lifetimeValueCents / 100, completed_jobs: metrics.completedJobCount, fsm_records: contact.externalIds },
    });
    return { ok: true, action: 'contact.upsert', externalId: contact.id };
  }

  async deliverTrigger(trigger: TriggerPayload, ctx: CrmContext): Promise<CrmResult> {
    this.push({ at: new Date().toISOString(), deliveryId: ctx.deliveryId, kind: 'trigger', key: trigger.key, fields: trigger.fields });
    return { ok: true, action: `trigger.${trigger.key}` };
  }
}
