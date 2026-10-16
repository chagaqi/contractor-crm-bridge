/**
 * FieldEdge (partner API; PascalCase JSON, .NET date formats).
 *
 * Envelope: `{ EventId, EventType: "WorkOrder.Completed", CompanyId, Timestamp, Data: { ... } }`.
 * Work orders are FieldEdge's jobs; "Quote"/"Estimate" are interchangeable; dates may arrive as
 * ISO strings or `/Date(1700000000000)/`. Field names are matched case-insensitively-by-alias
 * because FieldEdge integrations commonly differ between `Phone`, `PhoneNumber`, and `Phones[]`.
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
import { asArray, asRecord, buildAddress, dollarsToCents, isRecord, pick, splitName, str, toIso, type AnyRecord } from '../util.js';
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

const SOURCE = 'fieldedge' as const;

function feAddress(value: unknown) {
  const a = asRecord(value);
  return buildAddress({
    street: a.Address1 ?? a.Street,
    street2: a.Address2,
    city: a.City,
    region: a.State,
    postalCode: a.Zip ?? a.PostalCode,
    country: a.Country,
  });
}

export function feCustomer(record: unknown): NormalizedCustomer {
  const c = asRecord(record);
  const phones = asArray(c.Phones).map(asRecord);
  const mobileFirst = [...phones].sort((a, b) => (/mobile|cell/i.test(String(a.Type)) ? -1 : 0) - (/mobile|cell/i.test(String(b.Type)) ? -1 : 0));
  const rawName = str(c.DisplayName ?? c.Name);
  // "Last, First" → { first: First, last: Last }
  const commaName = rawName && /^[^,]+,\s*[^,]+$/.test(rawName) ? rawName.split(/,\s*/).reverse().join(' ') : rawName;
  const split = splitName(commaName);
  return buildCustomer({
    source: SOURCE,
    externalId: c.CustomerId ?? c.Id,
    firstName: c.FirstName ?? (c.CompanyName ? null : split.firstName),
    lastName: c.LastName ?? (c.CompanyName ? null : split.lastName),
    // FieldEdge DisplayName is usually "Last, First"; prefer explicit first/last when present.
    displayName: c.FirstName || c.LastName ? null : (c.DisplayName ?? c.Name),
    companyName: c.CompanyName,
    phones: [c.MobilePhone, c.CellPhone, ...mobileFirst.map((p) => p.Number ?? p.PhoneNumber), c.Phone, c.PhoneNumber],
    emails: [c.Email, c.EmailAddress, ...asArray(c.Emails)],
    address: feAddress(c.BillingAddress ?? c.Address),
    leadSource: c.LeadSource ?? c.MarketingSource,
    tags: c.Tags,
    doNotContact: c.DoNotContact === true || c.OptOut === true,
    createdAt: c.CreatedDate ?? c.CreatedOn,
  });
}

function feJobStatus(raw: string | null): JobStatus {
  const s = (raw ?? '').replace(/[\s_-]/g, '').toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'closed') return 'completed';
  if (s.includes('cancel')) return 'cancelled';
  if (s === 'dispatched' || s === 'enroute') return 'dispatched';
  if (s === 'inprogress' || s === 'working' || s === 'onsite') return 'in_progress';
  if (s === 'onhold' || s === 'hold') return 'on_hold';
  if (s === 'scheduled') return 'scheduled';
  return 'unscheduled';
}

export function feWorkOrder(record: unknown): NormalizedJob {
  const w = asRecord(record);
  const id = str(w.WorkOrderId ?? w.Id);
  if (!id) throw new NormalizationError('work order is missing an id', SOURCE);
  const customer = isRecord(w.Customer) ? feCustomer(w.Customer) : null;
  const rawStatus = str(w.Status);
  return {
    kind: 'job',
    source: SOURCE,
    externalId: id,
    number: str(w.WorkOrderNumber ?? w.Number),
    title: str(w.Description ?? w.TaskName ?? w.JobType),
    status: feJobStatus(rawStatus),
    rawStatus,
    customer,
    customerExternalId: customer?.externalId ?? str(w.CustomerId),
    address: feAddress(w.ServiceLocation ?? w.Location),
    technicians: asArray(w.Technicians ?? w.AssignedTechnicians).map((t) => {
      const r = asRecord(t);
      return { externalId: str(r.EmployeeId ?? r.Id), name: str(r.Name ?? r.DisplayName) ?? 'Technician' };
    }),
    scheduledStart: toIso(w.ScheduledDate ?? w.ScheduledStart),
    scheduledEnd: toIso(w.ScheduledEnd),
    dispatchedAt: toIso(w.DispatchedDate),
    startedAt: toIso(w.ArrivedDate ?? w.StartedDate),
    completedAt: toIso(w.CompletedDate),
    totalCents: dollarsToCents(w.TotalAmount ?? w.Total),
    satisfactionScore: normalizeScore(w.SurveyRating ?? w.CustomerRating),
    flags: [
      ...(w.IsCallback === true ? ['callback'] : []),
      ...(w.IsWarranty === true ? ['warranty'] : []),
      ...detectFlags(w.Tags, [w.JobType, w.CallType]),
    ].filter((v, i, a) => a.indexOf(v) === i),
    tags: asArray(w.Tags).map((t) => String(t).toLowerCase()),
  };
}

export function feEstimate(record: unknown): NormalizedEstimate {
  const e = asRecord(record);
  const id = str(e.EstimateId ?? e.QuoteId ?? e.Id);
  if (!id) throw new NormalizationError('estimate is missing an id', SOURCE);
  const raw = str(e.Status);
  const s = (raw ?? '').toLowerCase();
  const status: NormalizedEstimate['status'] =
    s === 'accepted' || s === 'approved' || s === 'sold'
      ? 'approved'
      : s === 'declined' || s === 'rejected' || s === 'lost'
        ? 'declined'
        : s === 'expired'
          ? 'expired'
          : s === 'presented' || s === 'sent' || s === 'open'
            ? 'sent'
            : 'draft';
  const customer = isRecord(e.Customer) ? feCustomer(e.Customer) : null;
  return {
    kind: 'estimate',
    source: SOURCE,
    externalId: id,
    number: str(e.EstimateNumber ?? e.QuoteNumber),
    title: str(e.Description ?? e.Name),
    status,
    rawStatus: raw,
    customer,
    customerExternalId: customer?.externalId ?? str(e.CustomerId),
    jobExternalId: str(e.WorkOrderId),
    totalCents: dollarsToCents(e.Total ?? e.TotalAmount),
    approvedAt: status === 'approved' ? toIso(e.AcceptedDate ?? e.ApprovedDate) : null,
    createdAt: toIso(e.CreatedDate),
  };
}

export function feInvoice(record: unknown): NormalizedInvoice {
  const i = asRecord(record);
  const id = str(i.InvoiceId ?? i.Id);
  if (!id) throw new NormalizationError('invoice is missing an id', SOURCE);
  const total = dollarsToCents(i.Total ?? i.TotalAmount);
  const balance = dollarsToCents(i.BalanceDue ?? i.Balance);
  const paid = i.AmountPaid !== undefined ? dollarsToCents(i.AmountPaid) : Math.max(0, total - balance);
  const raw = str(i.Status);
  const s = (raw ?? '').toLowerCase();
  const status: NormalizedInvoice['status'] = s.includes('void')
    ? 'void'
    : s.includes('disput')
      ? 'disputed'
      : s.includes('refund')
        ? 'refunded'
        : total > 0 && balance <= 0
          ? 'paid'
          : paid > 0
            ? 'partial'
            : s === 'draft'
              ? 'draft'
              : 'sent';
  const customer = isRecord(i.Customer) ? feCustomer(i.Customer) : null;
  return {
    kind: 'invoice',
    source: SOURCE,
    externalId: id,
    number: str(i.InvoiceNumber ?? i.Number),
    status,
    rawStatus: raw,
    customer,
    customerExternalId: customer?.externalId ?? str(i.CustomerId),
    jobExternalId: str(i.WorkOrderId),
    totalCents: total,
    amountPaidCents: paid,
    balanceCents: Math.max(0, balance),
    paidAt: status === 'paid' ? toIso(i.PaidDate ?? i.LastPaymentDate) : null,
    issuedAt: toIso(i.InvoiceDate),
    dueAt: toIso(i.DueDate),
  };
}

function key(name: string): string {
  return name.replace(/[^a-z]/gi, '').toLowerCase();
}

const MAP: Record<string, { kind: EntityKind; type: EventType | 'auto' }> = {
  customercreated: { kind: 'customer', type: 'customer.created' },
  customerupdated: { kind: 'customer', type: 'customer.updated' },
  workordercreated: { kind: 'job', type: 'job.created' },
  workorderscheduled: { kind: 'job', type: 'job.scheduled' },
  workorderdispatched: { kind: 'job', type: 'job.dispatched' },
  technicianenroute: { kind: 'job', type: 'job.dispatched' },
  workorderstarted: { kind: 'job', type: 'job.started' },
  workordercompleted: { kind: 'job', type: 'job.completed' },
  workordercancelled: { kind: 'job', type: 'job.cancelled' },
  workordercanceled: { kind: 'job', type: 'job.cancelled' },
  workorderupdated: { kind: 'job', type: 'auto' },
  workorderstatuschanged: { kind: 'job', type: 'auto' },
  estimatecreated: { kind: 'estimate', type: 'estimate.created' },
  quotecreated: { kind: 'estimate', type: 'estimate.created' },
  estimatepresented: { kind: 'estimate', type: 'estimate.sent' },
  estimateaccepted: { kind: 'estimate', type: 'estimate.approved' },
  estimateapproved: { kind: 'estimate', type: 'estimate.approved' },
  quoteapproved: { kind: 'estimate', type: 'estimate.approved' },
  quoteaccepted: { kind: 'estimate', type: 'estimate.approved' },
  estimatedeclined: { kind: 'estimate', type: 'estimate.declined' },
  invoicecreated: { kind: 'invoice', type: 'invoice.created' },
  invoicepaid: { kind: 'invoice', type: 'auto' },
  invoiceupdated: { kind: 'invoice', type: 'auto' },
  paymentreceived: { kind: 'invoice', type: 'auto' },
};

const INVOICE_TYPE: Record<NormalizedInvoice['status'], EventType> = {
  paid: 'invoice.paid',
  partial: 'invoice.partially_paid',
  void: 'invoice.voided',
  disputed: 'invoice.disputed',
  refunded: 'invoice.refunded',
  draft: 'invoice.created',
  sent: 'invoice.sent',
  overdue: 'invoice.sent',
};

export const fieldEdgeNormalizer: FsmNormalizer = {
  source: SOURCE,

  describe(body): WebhookDescriptor {
    const b = asRecord(body);
    const name = str(b.EventType ?? b.eventType ?? b.Event);
    if (!name) throw new NormalizationError('missing EventType', SOURCE);
    return {
      rawEventName: name,
      accountId: str(b.CompanyId ?? b.TenantId),
      deliveryId: str(b.EventId ?? b.Id),
      occurredAt: toIso(b.Timestamp ?? b.EventDate),
      hydrate: null,
    };
  },

  normalizeWebhook(body): NormalizedEvent[] {
    const b = asRecord(body);
    const d = this.describe(body);
    const meta = { accountId: d.accountId, occurredAt: d.occurredAt, rawEventName: d.rawEventName };
    const mapping = MAP[key(d.rawEventName)];
    if (!mapping) return [];
    const data: AnyRecord = asRecord(b.Data ?? pick(b, 'WorkOrder', 'Invoice', 'Estimate', 'Customer'));
    switch (mapping.kind) {
      case 'customer':
        return [makeEvent(SOURCE, mapping.type as EventType, feCustomer(data), meta)];
      case 'job': {
        const job = feWorkOrder(data);
        let type = mapping.type;
        if (type === 'auto') {
          type =
            job.status === 'completed'
              ? 'job.completed'
              : job.status === 'dispatched'
                ? 'job.dispatched'
                : job.status === 'cancelled'
                  ? 'job.cancelled'
                  : job.status === 'in_progress'
                    ? 'job.started'
                    : 'job.updated';
        }
        const forced: Partial<Record<EventType, JobStatus>> = {
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
        const est = feEstimate(data);
        const type = mapping.type as EventType;
        const patched = type === 'estimate.approved' ? { ...est, status: 'approved' as const, approvedAt: est.approvedAt ?? d.occurredAt } : est;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
      case 'invoice': {
        const inv = feInvoice(data);
        const type = mapping.type === 'auto' ? INVOICE_TYPE[inv.status] : mapping.type;
        const patched = inv.status === 'paid' && !inv.paidAt ? { ...inv, paidAt: d.occurredAt } : inv;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
    }
  },

  normalizeRecord(kind: EntityKind, record) {
    switch (kind) {
      case 'customer':
        return feCustomer(record);
      case 'job':
        return feWorkOrder(record);
      case 'estimate':
        return feEstimate(record);
      case 'invoice':
        return feInvoice(record);
    }
  },
};
