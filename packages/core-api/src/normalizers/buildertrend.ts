/**
 * Buildertrend (residential construction PM; partner API, snake_case JSON).
 *
 * Envelope: `{ delivery_id, event: "proposal.approved", builder_id, timestamp, data: { ... } }`.
 * Domain mapping:
 *   - Buildertrend "Job" (a project) → NormalizedJob; `closed` / `actual_completion` = completed.
 *   - Schedule item assignment (crew/sub assigned) → job.dispatched.
 *   - Lead "Proposal" → NormalizedEstimate.
 *   - Owner Invoice → NormalizedInvoice.
 *   - Job "owner" (the homeowner client) → NormalizedCustomer.
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
import { asArray, asRecord, buildAddress, dollarsToCents, isRecord, pick, pickStr, str, toIso, type AnyRecord } from '../util.js';
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

const SOURCE = 'buildertrend' as const;

export function btCustomer(record: unknown): NormalizedCustomer {
  const o = asRecord(record);
  return buildCustomer({
    source: SOURCE,
    externalId: o.id ?? o.owner_id ?? o.contact_id,
    firstName: o.first_name,
    lastName: o.last_name,
    displayName: o.display_name ?? o.name,
    companyName: o.company_name,
    phones: [o.cell_phone, o.mobile_phone, o.phone, o.work_phone],
    emails: [o.email, ...asArray(o.additional_emails)],
    address: buildAddress({ street: o.street_address ?? o.address, city: o.city, region: o.state, postalCode: o.zip, country: o.country }),
    leadSource: o.lead_source ?? o.source,
    tags: o.tags,
    doNotContact: o.opt_out === true,
    createdAt: o.created_at,
  });
}

function btJobStatus(raw: string | null, j: AnyRecord): JobStatus {
  const s = (raw ?? '').toLowerCase();
  if (s === 'closed' || s === 'completed' || j.actual_completion) return 'completed';
  if (s === 'cancelled' || s === 'canceled' || s === 'lost') return 'cancelled';
  if (s === 'warranty' || s === 'open' || s === 'in_progress') return j.actual_start ? 'in_progress' : 'scheduled';
  if (s === 'presale') return 'unscheduled';
  if (s === 'on_hold') return 'on_hold';
  return 'scheduled';
}

export function btJob(record: unknown): NormalizedJob {
  const j = asRecord(record);
  const id = str(j.id ?? j.job_id);
  if (!id) throw new NormalizationError('job is missing an id', SOURCE);
  const owner = j.owner ?? j.client ?? j.customer;
  const customer = isRecord(owner) ? btCustomer(owner) : null;
  const rawStatus = str(j.status);
  const assignees = asArray(j.assignees ?? j.assigned_users ?? j.crew).map(asRecord);
  const pm = isRecord(j.project_manager) ? [j.project_manager] : [];
  return {
    kind: 'job',
    source: SOURCE,
    externalId: id,
    number: str(j.job_number),
    title: str(j.job_name ?? j.title),
    status: btJobStatus(rawStatus, j),
    rawStatus,
    customer,
    customerExternalId: customer?.externalId ?? str(j.owner_id),
    address: buildAddress({ street: j.street_address, city: j.city, region: j.state, postalCode: j.zip, country: j.country }),
    technicians: [...assignees, ...pm].map((a) => ({
      externalId: str(a.id),
      name: str(a.name ?? [a.first_name, a.last_name].filter(Boolean).join(' ')) ?? 'Crew',
    })),
    scheduledStart: toIso(j.projected_start ?? j.start_date),
    scheduledEnd: toIso(j.projected_completion ?? j.end_date),
    dispatchedAt: null,
    startedAt: toIso(j.actual_start),
    completedAt: toIso(j.actual_completion ?? j.closed_date),
    totalCents: dollarsToCents(j.contract_price ?? j.revised_contract_price ?? j.total),
    satisfactionScore: normalizeScore(pick(j, 'survey.rating', 'customer_rating')),
    flags: detectFlags(j.tags, [j.job_type], asArray(j.warranty_claims).length ? ['warranty'] : []),
    tags: asArray(j.tags).map((t) => String(t).toLowerCase()),
  };
}

export function btProposal(record: unknown): NormalizedEstimate {
  const p = asRecord(record);
  const id = str(p.id ?? p.proposal_id);
  if (!id) throw new NormalizationError('proposal is missing an id', SOURCE);
  const raw = str(p.status);
  const s = (raw ?? '').toLowerCase();
  const status: NormalizedEstimate['status'] =
    s === 'approved' || s === 'accepted' || s === 'sold'
      ? 'approved'
      : s === 'declined' || s === 'rejected'
        ? 'declined'
        : s === 'released' || s === 'sent' || s === 'pending'
          ? 'sent'
          : s === 'expired'
            ? 'expired'
            : 'draft';
  const owner = p.owner ?? p.client ?? p.lead;
  const customer = isRecord(owner) ? btCustomer(owner) : null;
  return {
    kind: 'estimate',
    source: SOURCE,
    externalId: id,
    number: str(p.proposal_number),
    title: str(p.title),
    status,
    rawStatus: raw,
    customer,
    customerExternalId: customer?.externalId ?? str(p.owner_id),
    jobExternalId: str(p.job_id),
    totalCents: dollarsToCents(p.owner_price ?? p.total ?? p.amount),
    approvedAt: status === 'approved' ? toIso(p.approved_date ?? p.approved_at) : null,
    createdAt: toIso(p.created_at),
  };
}

export function btOwnerInvoice(record: unknown): NormalizedInvoice {
  const i = asRecord(record);
  const id = str(i.id ?? i.invoice_id);
  if (!id) throw new NormalizationError('owner invoice is missing an id', SOURCE);
  const total = dollarsToCents(i.amount ?? i.total);
  const paid = dollarsToCents(i.amount_paid ?? 0);
  const balance = i.balance !== undefined ? dollarsToCents(i.balance) : Math.max(0, total - paid);
  const raw = str(i.status);
  const s = (raw ?? '').toLowerCase();
  const status: NormalizedInvoice['status'] =
    s === 'void'
      ? 'void'
      : s.includes('disput')
        ? 'disputed'
        : s.includes('refund')
          ? 'refunded'
          : s === 'paid' || (total > 0 && balance <= 0)
            ? 'paid'
            : s === 'partially_paid' || paid > 0
              ? 'partial'
              : s === 'draft'
                ? 'draft'
                : 'sent';
  const owner = i.owner ?? i.client;
  const customer = isRecord(owner) ? btCustomer(owner) : null;
  return {
    kind: 'invoice',
    source: SOURCE,
    externalId: id,
    number: str(i.invoice_number),
    status,
    rawStatus: raw,
    customer,
    customerExternalId: customer?.externalId ?? str(i.owner_id),
    jobExternalId: pickStr(i, 'job_id', 'job.id'),
    totalCents: total,
    amountPaidCents: status === 'paid' && paid === 0 ? total : paid,
    balanceCents: status === 'paid' ? 0 : Math.max(0, balance),
    paidAt: status === 'paid' ? toIso(i.paid_date ?? i.paid_at) : null,
    issuedAt: toIso(i.released_date ?? i.created_at),
    dueAt: toIso(i.deadline ?? i.due_date),
  };
}

const MAP: Record<string, { kind: EntityKind; type: EventType | 'auto' }> = {
  'owner.created': { kind: 'customer', type: 'customer.created' },
  'owner.updated': { kind: 'customer', type: 'customer.updated' },
  'lead.created': { kind: 'customer', type: 'customer.created' },
  'job.created': { kind: 'job', type: 'job.created' },
  'job.updated': { kind: 'job', type: 'auto' },
  'job.status_changed': { kind: 'job', type: 'auto' },
  'job.closed': { kind: 'job', type: 'job.completed' },
  'schedule_item.assigned': { kind: 'job', type: 'job.dispatched' },
  'schedule_item.started': { kind: 'job', type: 'job.started' },
  'proposal.created': { kind: 'estimate', type: 'estimate.created' },
  'proposal.released': { kind: 'estimate', type: 'estimate.sent' },
  'proposal.approved': { kind: 'estimate', type: 'estimate.approved' },
  'proposal.declined': { kind: 'estimate', type: 'estimate.declined' },
  'owner_invoice.created': { kind: 'invoice', type: 'invoice.created' },
  'owner_invoice.released': { kind: 'invoice', type: 'invoice.sent' },
  'owner_invoice.paid': { kind: 'invoice', type: 'auto' },
  'owner_invoice.updated': { kind: 'invoice', type: 'auto' },
  'payment.received': { kind: 'invoice', type: 'auto' },
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

export const buildertrendNormalizer: FsmNormalizer = {
  source: SOURCE,

  describe(body): WebhookDescriptor {
    const b = asRecord(body);
    const name = str(b.event ?? b.event_type);
    if (!name) throw new NormalizationError('missing "event" field', SOURCE);
    return {
      rawEventName: name,
      accountId: str(b.builder_id ?? b.account_id),
      deliveryId: str(b.delivery_id ?? b.id),
      occurredAt: toIso(b.timestamp ?? b.occurred_at),
      hydrate: null,
    };
  },

  normalizeWebhook(body): NormalizedEvent[] {
    const b = asRecord(body);
    const d = this.describe(body);
    const meta = { accountId: d.accountId, occurredAt: d.occurredAt, rawEventName: d.rawEventName };
    const mapping = MAP[d.rawEventName.toLowerCase()];
    if (!mapping) return [];
    const data = asRecord(b.data);
    switch (mapping.kind) {
      case 'customer':
        return [makeEvent(SOURCE, mapping.type as EventType, btCustomer(data), meta)];
      case 'job': {
        // Schedule items wrap the job and list assigned crew.
        const jobRecord = isRecord(data.job) ? { ...data.job, assignees: data.assignees ?? (data.job as AnyRecord).assignees } : data;
        const job = btJob(jobRecord);
        let type = mapping.type;
        if (type === 'auto') type = job.status === 'completed' ? 'job.completed' : job.status === 'cancelled' ? 'job.cancelled' : 'job.updated';
        const forced: Partial<Record<EventType, JobStatus>> = {
          'job.dispatched': 'dispatched',
          'job.started': 'in_progress',
          'job.completed': 'completed',
          'job.cancelled': 'cancelled',
        };
        const patched: NormalizedJob = { ...job, status: forced[type] ?? job.status };
        if (type === 'job.dispatched') {
          patched.dispatchedAt = d.occurredAt;
          patched.scheduledStart = toIso(data.start_date) ?? patched.scheduledStart;
        }
        if (type === 'job.completed') patched.completedAt = patched.completedAt ?? d.occurredAt;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
      case 'estimate': {
        const est = btProposal(data);
        const type = mapping.type as EventType;
        const patched = type === 'estimate.approved' ? { ...est, status: 'approved' as const, approvedAt: est.approvedAt ?? d.occurredAt } : est;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
      case 'invoice': {
        const inv = btOwnerInvoice(isRecord(data.invoice) ? data.invoice : data);
        const type = mapping.type === 'auto' ? INVOICE_TYPE[inv.status] : mapping.type;
        const patched = inv.status === 'paid' && !inv.paidAt ? { ...inv, paidAt: d.occurredAt } : inv;
        return [makeEvent(SOURCE, type, patched, meta)];
      }
    }
  },

  normalizeRecord(kind: EntityKind, record) {
    switch (kind) {
      case 'customer':
        return btCustomer(record);
      case 'job':
        return btJob(record);
      case 'estimate':
        return btProposal(record);
      case 'invoice':
        return btOwnerInvoice(record);
    }
  },
};
