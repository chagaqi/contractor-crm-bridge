/**
 * ServiceTitan (REST API v2, https://api.servicetitan.io — jpm/crm/accounting/sales modules).
 *
 * Webhook envelope accepted in two shapes:
 *   1. `{ eventId, eventType: "JobCompleted", tenantId, createdOn, data: { ...entity } }`
 *   2. v2 webhook shape: `{ __eventInfo: { eventId, webhookType, tenantId }, ...entity }`
 * Money is decimal dollars. Customer contacts are `[{ type: "MobilePhone" | "Phone" | "Email", value }]`.
 */
import type {
  EventType,
  JobStatus,
  NormalizedCustomer,
  NormalizedEstimate,
  NormalizedEvent,
  NormalizedInvoice,
  NormalizedJob,
} from '../types.js';
import { asArray, asRecord, buildAddress, dollarsToCents, isRecord, pick, pickStr, splitName, str, toIso, type AnyRecord } from '../util.js';
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

const SOURCE = 'servicetitan' as const;

function stAddress(value: unknown) {
  const a = asRecord(value);
  return buildAddress({ street: a.street, street2: a.unit, city: a.city, region: a.state, postalCode: a.zip, country: a.country });
}

export function stCustomer(record: unknown): NormalizedCustomer {
  const c = asRecord(record);
  const contacts = asArray(c.contacts).map(asRecord);
  const byType = (re: RegExp) => contacts.filter((x) => re.test(String(x.type ?? ''))).map((x) => x.value);
  const phoneSettings = asArray(c.phoneSettings).map(asRecord);
  const name = str(c.name);
  const isCommercial = String(c.type ?? '').toLowerCase() === 'commercial';
  const split = splitName(isCommercial ? null : name);
  return buildCustomer({
    source: SOURCE,
    externalId: c.id,
    firstName: c.firstName ?? split.firstName,
    lastName: c.lastName ?? split.lastName,
    displayName: name,
    companyName: isCommercial ? name : null,
    phones: [
      ...byType(/^mobile/i),
      ...phoneSettings.filter((p) => /mobile/i.test(String(p.type ?? ''))).map((p) => p.phoneNumber),
      ...byType(/phone/i),
      ...phoneSettings.map((p) => p.phoneNumber),
      c.phone,
    ],
    emails: [...byType(/email/i), c.email],
    address: stAddress(c.address),
    leadSource: pick(c, 'campaign.name', 'leadSource', 'campaignName'),
    tags: asArray(c.tags ?? c.tagTypes).map((t) => (isRecord(t) ? t.name : t)),
    doNotContact: c.doNotService === true || c.doNotMail === true,
    createdAt: c.createdOn,
  });
}

function stJobStatus(raw: string | null): JobStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'hold':
    case 'onhold':
      return 'on_hold';
    case 'dispatched':
      return 'dispatched';
    case 'working':
    case 'inprogress':
      return 'in_progress';
    case 'scheduled':
      return 'scheduled';
    default:
      return 'unscheduled';
  }
}

export function stJob(record: unknown): NormalizedJob {
  const j = asRecord(record);
  const id = str(j.id);
  if (!id) throw new NormalizationError('job is missing an id', SOURCE);
  const customer = isRecord(j.customer) ? stCustomer(j.customer) : null;
  const appts = asArray(j.appointments).map(asRecord);
  const techSource = asArray(j.technicians ?? j.assignedTechnicians).map(asRecord);
  const technicians = techSource.map((t) => ({
    externalId: str(t.id ?? t.technicianId),
    name: str(t.name ?? t.technicianName) ?? 'Technician',
  }));
  const rawStatus = str(j.jobStatus ?? j.status);
  return {
    kind: 'job',
    source: SOURCE,
    externalId: id,
    number: str(j.jobNumber ?? j.number),
    title: str(j.summary ?? pick(j, 'jobType.name')),
    status: stJobStatus(rawStatus),
    rawStatus,
    customer,
    customerExternalId: customer?.externalId ?? str(j.customerId),
    address: stAddress(pick(j, 'location.address', 'address')),
    technicians,
    scheduledStart: toIso(j.start ?? appts[0]?.start),
    scheduledEnd: toIso(j.end ?? appts[0]?.end),
    dispatchedAt: toIso(j.dispatchedOn ?? appts[0]?.dispatchedOn),
    startedAt: toIso(j.workingOn ?? appts[0]?.arrivedOn),
    completedAt: toIso(j.completedOn),
    totalCents: dollarsToCents(j.total ?? j.invoiceTotal),
    satisfactionScore: normalizeScore(j.customerSatisfactionScore ?? j.surveyScore, j.surveyScale === 10 ? 10 : 5),
    flags: [
      ...(j.recallForId ? ['recall'] : []),
      ...(j.warrantyId ? ['warranty'] : []),
      ...detectFlags(j.tags ?? j.tagTypes, [pick(j, 'jobType.name')]),
    ].filter((v, i, a) => a.indexOf(v) === i),
    tags: asArray(j.tags ?? j.tagTypes).map((t) => String(isRecord(t) ? t.name : t).toLowerCase()),
  };
}

export function stEstimate(record: unknown): NormalizedEstimate {
  const e = asRecord(record);
  const id = str(e.id);
  if (!id) throw new NormalizationError('estimate is missing an id', SOURCE);
  const statusName = pickStr(e, 'status.name', 'status');
  const s = (statusName ?? '').toLowerCase();
  const status: NormalizedEstimate['status'] = s === 'sold' ? 'approved' : s === 'dismissed' ? 'declined' : s === 'open' ? 'sent' : 'draft';
  const customer = isRecord(e.customer) ? stCustomer(e.customer) : null;
  return {
    kind: 'estimate',
    source: SOURCE,
    externalId: id,
    number: str(e.number ?? e.estimateNumber),
    title: str(e.name ?? e.summary),
    status,
    rawStatus: statusName,
    customer,
    customerExternalId: customer?.externalId ?? str(e.customerId),
    jobExternalId: str(e.jobId),
    totalCents: dollarsToCents(e.total ?? (Number(e.subtotal ?? 0) + Number(e.tax ?? 0))),
    approvedAt: status === 'approved' ? toIso(e.soldOn) : null,
    createdAt: toIso(e.createdOn),
  };
}

export function stInvoice(record: unknown): NormalizedInvoice {
  const i = asRecord(record);
  const id = str(i.id);
  if (!id) throw new NormalizationError('invoice is missing an id', SOURCE);
  const total = dollarsToCents(i.total);
  const balance = dollarsToCents(i.balance);
  const paid = Math.max(0, total - balance);
  const raw = pickStr(i, 'status.name', 'status', 'syncStatus');
  const s = (raw ?? '').toLowerCase();
  const status: NormalizedInvoice['status'] = /void|cancel/.test(s)
    ? 'void'
    : /disput|chargeback/.test(s)
      ? 'disputed'
      : /refund/.test(s)
        ? 'refunded'
        : total > 0 && balance <= 0
          ? 'paid'
          : paid > 0
            ? 'partial'
            : 'sent';
  const customer = isRecord(i.customer) && i.customer.id !== undefined ? stCustomer(i.customer) : null;
  return {
    kind: 'invoice',
    source: SOURCE,
    externalId: id,
    number: str(i.referenceNumber ?? i.number),
    status,
    rawStatus: raw,
    customer,
    customerExternalId: customer?.externalId ?? pickStr(i, 'customer.id', 'customerId'),
    jobExternalId: pickStr(i, 'job.id', 'jobId'),
    totalCents: total,
    amountPaidCents: paid,
    balanceCents: Math.max(0, balance),
    paidAt: status === 'paid' ? toIso(i.paidOn ?? i.modifiedOn) : null,
    issuedAt: toIso(i.invoiceDate),
    dueAt: toIso(i.dueDate),
  };
}

const EVENT_MAP: Record<string, { kind: EntityKind; type: EventType | 'auto' }> = {
  customercreated: { kind: 'customer', type: 'customer.created' },
  customerupdated: { kind: 'customer', type: 'customer.updated' },
  jobcreated: { kind: 'job', type: 'job.created' },
  jobbooked: { kind: 'job', type: 'job.created' },
  jobscheduled: { kind: 'job', type: 'job.scheduled' },
  appointmentscheduled: { kind: 'job', type: 'job.scheduled' },
  technicianassigned: { kind: 'job', type: 'job.dispatched' },
  techniciandispatched: { kind: 'job', type: 'job.dispatched' },
  appointmentdispatched: { kind: 'job', type: 'job.dispatched' },
  jobdispatched: { kind: 'job', type: 'job.dispatched' },
  jobstarted: { kind: 'job', type: 'job.started' },
  technicianarrived: { kind: 'job', type: 'job.started' },
  jobcompleted: { kind: 'job', type: 'job.completed' },
  jobcomplete: { kind: 'job', type: 'job.completed' },
  jobcanceled: { kind: 'job', type: 'job.cancelled' },
  jobcancelled: { kind: 'job', type: 'job.cancelled' },
  jobupdated: { kind: 'job', type: 'auto' },
  estimatecreated: { kind: 'estimate', type: 'estimate.created' },
  estimatesold: { kind: 'estimate', type: 'estimate.approved' },
  estimateapproved: { kind: 'estimate', type: 'estimate.approved' },
  estimatedismissed: { kind: 'estimate', type: 'estimate.declined' },
  estimateupdated: { kind: 'estimate', type: 'auto' },
  invoicecreated: { kind: 'invoice', type: 'invoice.created' },
  invoiceupdated: { kind: 'invoice', type: 'auto' },
  invoicepaid: { kind: 'invoice', type: 'auto' },
  paymentcreated: { kind: 'invoice', type: 'auto' },
  paymentapplied: { kind: 'invoice', type: 'auto' },
};

function eventKey(name: string): string {
  return name.replace(/[^a-z]/gi, '').toLowerCase();
}

function entityOf(body: AnyRecord): AnyRecord {
  if (isRecord(body.data)) return body.data;
  const { __eventInfo: _info, ...rest } = body;
  return rest;
}

export const serviceTitanNormalizer: FsmNormalizer = {
  source: SOURCE,

  describe(body): WebhookDescriptor {
    const b = asRecord(body);
    const info = asRecord(b.__eventInfo);
    const name = str(b.eventType ?? info.webhookType ?? info.eventType ?? b.type);
    if (!name) throw new NormalizationError('missing eventType', SOURCE);
    return {
      rawEventName: name,
      accountId: str(b.tenantId ?? info.tenantId),
      deliveryId: str(b.eventId ?? info.eventId),
      occurredAt: toIso(b.createdOn ?? info.createdOn ?? b.timestamp),
      hydrate: null,
    };
  },

  normalizeWebhook(body): NormalizedEvent[] {
    const b = asRecord(body);
    const d = this.describe(body);
    const meta = { accountId: d.accountId, occurredAt: d.occurredAt, rawEventName: d.rawEventName };
    const mapping = EVENT_MAP[eventKey(d.rawEventName)];
    if (!mapping) return [];
    const data = entityOf(b);

    switch (mapping.kind) {
      case 'customer':
        return [makeEvent(SOURCE, mapping.type as EventType, stCustomer(data), meta)];
      case 'job': {
        // Dispatch events may carry an appointment-assignment record wrapping the job.
        const jobRecord = isRecord(data.job)
          ? {
              ...data.job,
              technicians: (data.job as AnyRecord).technicians ?? (data.technicianId ? [{ id: data.technicianId, name: data.technicianName }] : undefined),
              dispatchedOn: (data.job as AnyRecord).dispatchedOn ?? data.dispatchedOn,
            }
          : data;
        const job = stJob(jobRecord);
        let type = mapping.type;
        if (type === 'auto') type = job.status === 'completed' ? 'job.completed' : job.status === 'cancelled' ? 'job.cancelled' : 'job.updated';
        const forced: Partial<Record<EventType, NormalizedJob['status']>> = {
          'job.dispatched': 'dispatched',
          'job.started': 'in_progress',
          'job.completed': 'completed',
          'job.cancelled': 'cancelled',
        };
        const patched: NormalizedJob = { ...job, status: forced[type] ?? job.status };
        if (type === 'job.dispatched') patched.dispatchedAt = patched.dispatchedAt ?? d.occurredAt;
        if (type === 'job.completed') patched.completedAt = patched.completedAt ?? d.occurredAt;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
      case 'estimate': {
        const est = stEstimate(data);
        let type = mapping.type;
        if (type === 'auto') type = est.status === 'approved' ? 'estimate.approved' : est.status === 'declined' ? 'estimate.declined' : 'estimate.sent';
        const patched = type === 'estimate.approved' ? { ...est, status: 'approved' as const, approvedAt: est.approvedAt ?? d.occurredAt } : est;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
      case 'invoice': {
        const invRecord = isRecord(data.invoice) ? data.invoice : data;
        const inv = stInvoice(invRecord);
        let type = mapping.type;
        if (type === 'auto') {
          type =
            inv.status === 'paid'
              ? 'invoice.paid'
              : inv.status === 'partial'
                ? 'invoice.partially_paid'
                : inv.status === 'void'
                  ? 'invoice.voided'
                  : inv.status === 'disputed'
                    ? 'invoice.disputed'
                    : inv.status === 'refunded'
                      ? 'invoice.refunded'
                      : 'invoice.sent';
        }
        const patched = inv.status === 'paid' && !inv.paidAt ? { ...inv, paidAt: d.occurredAt } : inv;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
    }
  },

  normalizeRecord(kind: EntityKind, record) {
    switch (kind) {
      case 'customer':
        return stCustomer(record);
      case 'job':
        return stJob(record);
      case 'estimate':
        return stEstimate(record);
      case 'invoice':
        return stInvoice(record);
    }
  },
};
