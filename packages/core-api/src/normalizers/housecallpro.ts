/**
 * Housecall Pro (REST API v1, https://api.housecallpro.com).
 *
 * Webhooks are *fat*: `{ event: "job.completed", company_id, job: { ...full job } }`.
 * Money is already integer cents (`total_amount`, `outstanding_balance`).
 */
import type {
  EstimateStatus,
  EventType,
  JobStatus,
  NormalizedCustomer,
  NormalizedEstimate,
  NormalizedEvent,
  NormalizedInvoice,
  NormalizedJob,
} from '../types.js';
import { asArray, asRecord, buildAddress, centsValue, isRecord, pick, pickStr, str, toIso, type AnyRecord } from '../util.js';
import {
  buildCustomer,
  detectFlags,
  makeEvent,
  NormalizationError,
  normalizeScore,
  type EntityKind,
  type FsmNormalizer,
  type WebhookDescriptor,
} from './common.js';

const SOURCE = 'housecallpro' as const;

function hcpAddress(value: unknown) {
  const a = asRecord(value);
  return buildAddress({
    street: a.street,
    street2: a.street_line_2,
    city: a.city,
    region: a.state,
    postalCode: a.zip,
    country: a.country,
  });
}

export function hcpCustomer(record: unknown): NormalizedCustomer {
  const c = asRecord(record);
  const addresses = asArray(c.addresses);
  return buildCustomer({
    source: SOURCE,
    externalId: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    companyName: c.company,
    phones: [c.mobile_number, c.home_number, c.work_number],
    emails: [c.email, ...asArray(c.additional_emails)],
    address: addresses.length ? hcpAddress(addresses[0]) : null,
    leadSource: c.lead_source,
    tags: c.tags,
    doNotContact: c.notifications_enabled === false,
    createdAt: c.created_at,
  });
}

function hcpJobStatus(raw: string | null, ts: AnyRecord): JobStatus {
  const s = (raw ?? '').toLowerCase();
  if (s.startsWith('complete')) return 'completed';
  if (s.includes('cancel')) return 'cancelled';
  if (s === 'in progress') return 'in_progress';
  if (s === 'scheduled') return ts.on_my_way_at ? 'dispatched' : 'scheduled';
  if (s === 'needs scheduling' || s === 'unscheduled') return 'unscheduled';
  return 'scheduled';
}

export function hcpJob(record: unknown): NormalizedJob {
  const j = asRecord(record);
  const id = str(j.id);
  if (!id) throw new NormalizationError('job is missing an id', SOURCE);
  const ts = asRecord(j.work_timestamps);
  const customer = isRecord(j.customer) ? hcpCustomer(j.customer) : null;
  const rawStatus = str(j.work_status);
  return {
    kind: 'job',
    source: SOURCE,
    externalId: id,
    number: str(j.invoice_number),
    title: str(j.description),
    status: hcpJobStatus(rawStatus, ts),
    rawStatus,
    customer,
    customerExternalId: customer?.externalId ?? str(j.customer_id),
    address: hcpAddress(j.address),
    technicians: asArray(j.assigned_employees).map((e) => {
      const emp = asRecord(e);
      return {
        externalId: str(emp.id),
        name: [str(emp.first_name), str(emp.last_name)].filter(Boolean).join(' ') || 'Technician',
      };
    }),
    scheduledStart: toIso(pick(j, 'schedule.scheduled_start')),
    scheduledEnd: toIso(pick(j, 'schedule.scheduled_end')),
    dispatchedAt: toIso(ts.on_my_way_at),
    startedAt: toIso(ts.started_at),
    completedAt: toIso(ts.completed_at),
    totalCents: centsValue(j.total_amount),
    // HCP's "complete rated" status carries the customer's 1-5 star rating.
    satisfactionScore: normalizeScore(pick(j, 'rating', 'customer_rating', 'review.rating')),
    flags: detectFlags(j.tags, [j.lead_source]),
    tags: asArray(j.tags).map((t) => String(t).toLowerCase()),
  };
}

function optionStatus(options: AnyRecord[]): { status: EstimateStatus; approved: AnyRecord | undefined } {
  const approved = options.find((o) => String(o.approval_status ?? '').toLowerCase() === 'approved');
  if (approved) return { status: 'approved', approved };
  if (options.length && options.every((o) => String(o.approval_status ?? '').toLowerCase() === 'declined')) {
    return { status: 'declined', approved: undefined };
  }
  return { status: 'sent', approved: undefined };
}

export function hcpEstimate(record: unknown): NormalizedEstimate {
  const e = asRecord(record);
  const id = str(e.id);
  if (!id) throw new NormalizationError('estimate is missing an id', SOURCE);
  const options = asArray(e.options).map(asRecord);
  const { status, approved } = optionStatus(options);
  const customer = isRecord(e.customer) ? hcpCustomer(e.customer) : null;
  const total = approved
    ? centsValue(approved.total_amount)
    : Math.max(0, ...options.map((o) => centsValue(o.total_amount)), centsValue(e.total_amount));
  return {
    kind: 'estimate',
    source: SOURCE,
    externalId: id,
    number: str(e.estimate_number),
    title: str(approved?.name ?? e.description ?? options[0]?.name),
    status,
    rawStatus: str(approved?.approval_status ?? e.work_status),
    customer,
    customerExternalId: customer?.externalId ?? str(e.customer_id),
    jobExternalId: str(e.job_id),
    totalCents: total,
    approvedAt: status === 'approved' ? toIso(approved?.approved_at ?? e.updated_at) : null,
    createdAt: toIso(e.created_at),
  };
}

/** HCP invoices live on jobs; accept either an `invoice` object or derive one from a paid job. */
export function hcpInvoice(record: unknown, job?: NormalizedJob): NormalizedInvoice {
  const i = asRecord(record);
  const id = str(i.id) ?? (job ? `job-${job.externalId}` : null);
  if (!id) throw new NormalizationError('invoice is missing an id', SOURCE);
  const total = centsValue(i.amount ?? i.total_amount ?? job?.totalCents);
  const balance = centsValue(i.due_amount ?? i.outstanding_balance);
  const paid = i.paid_amount !== undefined ? centsValue(i.paid_amount) : Math.max(0, total - balance);
  const raw = str(i.status);
  const s = (raw ?? '').toLowerCase();
  const status: NormalizedInvoice['status'] =
    s === 'void' || s === 'voided' || s === 'canceled'
      ? 'void'
      : s === 'refunded'
        ? 'refunded'
        : s.includes('disput')
          ? 'disputed'
          : balance <= 0 && total > 0
            ? 'paid'
            : paid > 0
              ? 'partial'
              : s === 'draft'
                ? 'draft'
                : 'sent';
  const customer = isRecord(i.customer) ? hcpCustomer(i.customer) : (job?.customer ?? null);
  return {
    kind: 'invoice',
    source: SOURCE,
    externalId: id,
    number: str(i.invoice_number) ?? job?.number ?? null,
    status,
    rawStatus: raw,
    customer,
    customerExternalId: customer?.externalId ?? str(i.customer_id),
    jobExternalId: str(i.job_id) ?? job?.externalId ?? null,
    totalCents: total,
    amountPaidCents: paid,
    balanceCents: Math.max(0, balance),
    paidAt: status === 'paid' ? toIso(i.paid_at ?? i.updated_at) : null,
    issuedAt: toIso(i.invoice_date ?? i.sent_at ?? i.created_at),
    dueAt: toIso(i.due_at),
  };
}

const JOB_EVENTS: Record<string, EventType> = {
  'job.created': 'job.created',
  'job.scheduled': 'job.scheduled',
  'job.appointment.scheduled': 'job.scheduled',
  'job.appointment.rescheduled': 'job.scheduled',
  'job.on_my_way': 'job.dispatched',
  'job.appointment.appointment_pros_assigned': 'job.dispatched',
  'job.started': 'job.started',
  'job.completed': 'job.completed',
  'job.canceled': 'job.cancelled',
  'job.deleted': 'job.cancelled',
  'job.updated': 'job.updated',
};

export const housecallProNormalizer: FsmNormalizer = {
  source: SOURCE,

  describe(body): WebhookDescriptor {
    const b = asRecord(body);
    const event = str(b.event);
    if (!event) throw new NormalizationError('missing "event" field', SOURCE);
    const entity = asRecord(b.job ?? b.estimate ?? b.invoice ?? b.customer);
    const occurredAt =
      toIso(b.timestamp ?? b.event_time) ??
      toIso(pick(entity, 'work_timestamps.completed_at', 'updated_at', 'created_at'));
    return {
      rawEventName: event,
      accountId: pickStr(b, 'company_id', 'company.id'),
      deliveryId: str(b.id ?? b.event_id),
      occurredAt,
      hydrate: null,
    };
  },

  normalizeWebhook(body): NormalizedEvent[] {
    const b = asRecord(body);
    const d = this.describe(body);
    const meta = { accountId: d.accountId, occurredAt: d.occurredAt, rawEventName: d.rawEventName };
    const event = d.rawEventName;

    if (event.startsWith('customer.')) {
      if (!isRecord(b.customer) || event === 'customer.deleted') return [];
      const type: EventType = event === 'customer.created' ? 'customer.created' : 'customer.updated';
      return [makeEvent(SOURCE, type, hcpCustomer(b.customer), meta)];
    }

    if (event === 'job.paid') {
      const job = hcpJob(b.job);
      const invoice = hcpInvoice({ ...asRecord(b.invoice), outstanding_balance: asRecord(b.job).outstanding_balance ?? 0 }, job);
      const paidAt = toIso(asRecord(b.invoice).paid_at) ?? d.occurredAt;
      return [makeEvent(SOURCE, invoice.status === 'paid' ? 'invoice.paid' : 'invoice.partially_paid', { ...invoice, paidAt: invoice.status === 'paid' ? paidAt : null }, meta)];
    }

    if (event.startsWith('job.')) {
      const type = JOB_EVENTS[event];
      if (!type || !isRecord(b.job)) return [];
      const job = hcpJob(b.job);
      const statusFor: Partial<Record<EventType, NormalizedJob['status']>> = {
        'job.dispatched': 'dispatched',
        'job.started': 'in_progress',
        'job.completed': 'completed',
        'job.cancelled': 'cancelled',
      };
      const forced = statusFor[type];
      const patched: NormalizedJob = forced ? { ...job, status: forced } : job;
      if (type === 'job.dispatched' && !patched.dispatchedAt) patched.dispatchedAt = d.occurredAt;
      if (type === 'job.completed' && !patched.completedAt) patched.completedAt = d.occurredAt;
      return [makeEvent(SOURCE, type, patched, meta)];
    }

    if (event.startsWith('estimate.')) {
      if (!isRecord(b.estimate)) return [];
      const est = hcpEstimate(b.estimate);
      let type: EventType;
      if (event === 'estimate.created') type = 'estimate.created';
      else if (event === 'estimate.sent') type = 'estimate.sent';
      else if (est.status === 'approved') type = 'estimate.approved';
      else if (est.status === 'declined') type = 'estimate.declined';
      else type = 'estimate.sent';
      return [makeEvent(SOURCE, type, type === 'estimate.approved' && !est.approvedAt ? { ...est, approvedAt: d.occurredAt } : est, meta)];
    }

    if (event.startsWith('invoice.')) {
      if (!isRecord(b.invoice)) return [];
      const inv = hcpInvoice(b.invoice);
      const map: Record<NormalizedInvoice['status'], EventType> = {
        paid: 'invoice.paid',
        partial: 'invoice.partially_paid',
        void: 'invoice.voided',
        disputed: 'invoice.disputed',
        refunded: 'invoice.refunded',
        draft: 'invoice.created',
        sent: event === 'invoice.created' ? 'invoice.created' : 'invoice.sent',
        overdue: 'invoice.sent',
      };
      return [makeEvent(SOURCE, map[inv.status], inv, meta)];
    }
    return [];
  },

  normalizeRecord(kind: EntityKind, record) {
    switch (kind) {
      case 'customer':
        return hcpCustomer(record);
      case 'job':
        return hcpJob(record);
      case 'estimate':
        return hcpEstimate(record);
      case 'invoice':
        return hcpInvoice(record);
    }
  },
};
