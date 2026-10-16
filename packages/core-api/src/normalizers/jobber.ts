/**
 * Jobber (GraphQL API, https://api.getjobber.com/api/graphql).
 *
 * Jobber webhooks are *thin*: they carry `{ data: { webHookEvent: { topic, accountId, itemId, occurredAt } } }`
 * and the receiver must fetch the item over GraphQL. `describe()` returns the hydration request and
 * `normalizeWebhook(body, hydratedNode)` maps the GraphQL node. For convenience (and for the sandbox),
 * a pre-hydrated node may also be embedded under `data.webHookEvent.item`.
 */
import type {
  EstimateStatus,
  EventType,
  InvoiceStatus,
  JobStatus,
  NormalizedCustomer,
  NormalizedEstimate,
  NormalizedEvent,
  NormalizedInvoice,
  NormalizedJob,
  NormalizedTechnician,
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
  type HydrationKind,
  type WebhookDescriptor,
} from './common.js';

const SOURCE = 'jobber' as const;

const TOPIC_KIND: Record<string, HydrationKind> = {
  CLIENT: 'customer',
  JOB: 'job',
  QUOTE: 'estimate',
  INVOICE: 'invoice',
  VISIT: 'visit',
  PAYMENT: 'payment',
};

function topicOf(body: unknown): AnyRecord {
  return asRecord(pick(body, 'data.webHookEvent', 'webHookEvent'));
}

function sortedPrimaryFirst(list: unknown, valueKey: string): unknown[] {
  const items = asArray(list).map(asRecord);
  const score = (item: AnyRecord) => {
    const desc = String(item.description ?? item.label ?? '').toLowerCase();
    return (item.primary ? 0 : 2) + (desc.includes('mobile') || item.smsAllowed ? 0 : 1);
  };
  return [...items].sort((a, b) => score(a) - score(b)).map((item) => item[valueKey]);
}

export function jobberCustomer(node: unknown): NormalizedCustomer {
  const c = asRecord(node);
  const addr = asRecord(c.billingAddress ?? pick(c, 'properties.nodes.0.address'));
  return buildCustomer({
    source: SOURCE,
    externalId: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    displayName: c.name,
    companyName: c.companyName,
    phones: sortedPrimaryFirst(c.phones, 'number'),
    emails: sortedPrimaryFirst(c.emails, 'address'),
    address: buildAddress({
      street: addr.street1 ?? addr.street,
      street2: addr.street2,
      city: addr.city,
      region: addr.province,
      postalCode: addr.postalCode,
      country: addr.country,
    }),
    leadSource: pick(c, 'leadSource', 'sourceAttribution.source', 'sourceAttribution.sourceText'),
    tags: c.tags,
    doNotContact: c.receivesReminders === false && c.receivesFollowUps === false,
    createdAt: c.createdAt,
  });
}

function technicians(visits: unknown[]): NormalizedTechnician[] {
  const out: NormalizedTechnician[] = [];
  for (const visit of visits) {
    for (const user of asArray(asRecord(visit).assignedUsers)) {
      const u = asRecord(user);
      const name = pickStr(u, 'name.full', 'name') ?? 'Technician';
      const id = str(u.id);
      if (!out.some((t) => t.externalId === id && t.name === name)) out.push({ externalId: id, name });
    }
  }
  return out;
}

function jobStatus(raw: string | null, completedAt: string | null): JobStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'requires_invoicing':
    case 'archived':
      return 'completed';
    case 'active':
    case 'today':
    case 'late':
    case 'action_required':
      return 'in_progress';
    case 'upcoming':
      return 'scheduled';
    case 'on_hold':
      return 'on_hold';
    case 'unscheduled':
      return 'unscheduled';
    case 'destroyed':
      return 'cancelled';
    default:
      return completedAt ? 'completed' : 'scheduled';
  }
}

export function jobberJob(node: unknown, overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  const j = asRecord(node);
  const id = str(j.id);
  if (!id) throw new NormalizationError('job is missing an id', SOURCE);
  const visits = asArray(j.visits).map(asRecord);
  const customer = isRecord(j.client) ? jobberCustomer(j.client) : null;
  const addr = asRecord(pick(j, 'property.address'));
  const completedAt = toIso(j.completedAt ?? visits.find((v) => v.completedAt)?.completedAt);
  const rawStatus = str(j.jobStatus);
  const firstVisit = visits[0] ?? {};
  const customFields = asArray(j.customFields).map(asRecord);
  const satisfaction = customFields.find((f) => /satisf|rating|nps/i.test(String(f.label ?? '')));
  return {
    kind: 'job',
    source: SOURCE,
    externalId: id,
    number: str(j.jobNumber),
    title: str(j.title),
    status: jobStatus(rawStatus, completedAt),
    rawStatus,
    customer,
    customerExternalId: customer?.externalId ?? pickStr(j, 'client.id'),
    address: buildAddress({
      street: addr.street1,
      street2: addr.street2,
      city: addr.city,
      region: addr.province,
      postalCode: addr.postalCode,
      country: addr.country,
    }),
    technicians: technicians(visits),
    scheduledStart: toIso(j.startAt ?? firstVisit.startAt),
    scheduledEnd: toIso(j.endAt ?? firstVisit.endAt),
    dispatchedAt: null,
    startedAt: null,
    completedAt,
    totalCents: dollarsToCents(j.total),
    satisfactionScore: normalizeScore(satisfaction?.valueNumeric ?? satisfaction?.valueText ?? satisfaction?.value),
    flags: detectFlags(j.tags, j.jobType ? [j.jobType] : [], customFields.map((f) => f.valueText)),
    tags: asArray(j.tags).map((t) => String(asRecord(t).label ?? t).toLowerCase()),
    ...overrides,
  };
}

function quoteStatus(raw: string | null): EstimateStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'approved':
    case 'converted':
      return 'approved';
    case 'awaiting_response':
    case 'changes_requested':
      return 'sent';
    case 'archived':
      return 'declined';
    default:
      return 'draft';
  }
}

export function jobberQuote(node: unknown): NormalizedEstimate {
  const q = asRecord(node);
  const id = str(q.id);
  if (!id) throw new NormalizationError('quote is missing an id', SOURCE);
  const customer = isRecord(q.client) ? jobberCustomer(q.client) : null;
  const rawStatus = str(q.quoteStatus);
  const status = quoteStatus(rawStatus);
  return {
    kind: 'estimate',
    source: SOURCE,
    externalId: id,
    number: str(q.quoteNumber),
    title: str(q.title),
    status,
    rawStatus,
    customer,
    customerExternalId: customer?.externalId ?? pickStr(q, 'client.id'),
    jobExternalId: pickStr(q, 'jobs.nodes.0.id', 'job.id'),
    totalCents: dollarsToCents(pick(q, 'amounts.total', 'total')),
    approvedAt: status === 'approved' ? toIso(q.approvedAt ?? q.updatedAt) : null,
    createdAt: toIso(q.createdAt),
  };
}

function invoiceStatus(raw: string | null, balance: number, paid: number): InvoiceStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'paid':
      return 'paid';
    case 'past_due':
      return paid > 0 ? 'partial' : 'overdue';
    case 'bad_debt':
      return 'disputed';
    case 'void':
    case 'voided':
      return 'void';
    case 'draft':
      return 'draft';
    case 'awaiting_payment':
      return paid > 0 && balance > 0 ? 'partial' : 'sent';
    default:
      if (balance <= 0 && paid > 0) return 'paid';
      return paid > 0 ? 'partial' : 'sent';
  }
}

export function jobberInvoice(node: unknown): NormalizedInvoice {
  const i = asRecord(node);
  const id = str(i.id);
  if (!id) throw new NormalizationError('invoice is missing an id', SOURCE);
  const customer = isRecord(i.client) ? jobberCustomer(i.client) : null;
  const total = dollarsToCents(pick(i, 'amounts.total', 'total'));
  const balance = dollarsToCents(pick(i, 'amounts.invoiceBalance', 'invoiceBalance'));
  const paidField = pick(i, 'amounts.paymentsTotal', 'paymentsTotal');
  const paid = paidField === undefined ? Math.max(0, total - balance) : dollarsToCents(paidField);
  const rawStatus = str(i.invoiceStatus);
  const status = invoiceStatus(rawStatus, balance, paid);
  return {
    kind: 'invoice',
    source: SOURCE,
    externalId: id,
    number: str(i.invoiceNumber),
    status,
    rawStatus,
    customer,
    customerExternalId: customer?.externalId ?? pickStr(i, 'client.id'),
    jobExternalId: pickStr(i, 'jobs.nodes.0.id', 'job.id'),
    totalCents: total,
    amountPaidCents: paid,
    balanceCents: balance,
    paidAt: status === 'paid' ? toIso(i.receivedDate ?? i.paidAt ?? i.updatedAt) : null,
    issuedAt: toIso(i.issuedDate),
    dueAt: toIso(i.dueDate),
  };
}

function invoiceEventType(invoice: NormalizedInvoice): EventType {
  switch (invoice.status) {
    case 'paid':
      return 'invoice.paid';
    case 'partial':
      return 'invoice.partially_paid';
    case 'void':
      return 'invoice.voided';
    case 'disputed':
      return 'invoice.disputed';
    case 'draft':
      return 'invoice.created';
    default:
      return 'invoice.sent';
  }
}

export const jobberNormalizer: FsmNormalizer = {
  source: SOURCE,

  describe(body): WebhookDescriptor {
    const evt = topicOf(body);
    const topic = str(evt.topic);
    if (!topic) throw new NormalizationError('missing data.webHookEvent.topic', SOURCE);
    const prefix = topic.split('_')[0] ?? '';
    const kind = TOPIC_KIND[prefix];
    const itemId = str(evt.itemId);
    return {
      rawEventName: topic,
      accountId: str(evt.accountId),
      deliveryId: itemId ? `${topic}:${itemId}:${str(evt.occurredAt) ?? ''}` : null,
      occurredAt: toIso(evt.occurredAt),
      hydrate: kind && itemId && !isRecord(evt.item) ? { kind, id: itemId, accountId: str(evt.accountId) } : null,
    };
  },

  normalizeWebhook(body, hydrated): NormalizedEvent[] {
    const evt = topicOf(body);
    const d = this.describe(body);
    const node = isRecord(evt.item) ? evt.item : hydrated;
    if (!isRecord(node)) {
      if (d.hydrate) throw new NormalizationError(`topic ${d.rawEventName} requires a hydrated ${d.hydrate.kind}`, SOURCE);
      return [];
    }
    const meta = { accountId: d.accountId, occurredAt: d.occurredAt, rawEventName: d.rawEventName };
    const topic = d.rawEventName;

    switch (topic) {
      case 'CLIENT_CREATE':
        return [makeEvent(SOURCE, 'customer.created', jobberCustomer(node), meta)];
      case 'CLIENT_UPDATE':
        return [makeEvent(SOURCE, 'customer.updated', jobberCustomer(node), meta)];
      case 'JOB_CREATE':
        return [makeEvent(SOURCE, 'job.created', jobberJob(node), meta)];
      case 'JOB_UPDATE': {
        const job = jobberJob(node);
        const type: EventType = job.status === 'completed' ? 'job.completed' : job.status === 'cancelled' ? 'job.cancelled' : 'job.updated';
        return [makeEvent(SOURCE, type, job, meta)];
      }
      case 'JOB_COMPLETE':
      case 'JOB_CLOSED': {
        const job = jobberJob(node);
        return [
          makeEvent(SOURCE, 'job.completed', { ...job, status: 'completed', completedAt: job.completedAt ?? d.occurredAt }, meta),
        ];
      }
      case 'JOB_DESTROY':
        return [makeEvent(SOURCE, 'job.cancelled', jobberJob(node, { status: 'cancelled' }), meta)];
      case 'VISIT_CREATE':
      case 'VISIT_UPDATE':
      case 'VISIT_COMPLETE': {
        // A visit is one appointment on a job. Assigning a team member == dispatching a technician.
        const visit = node;
        const job = jobberJob(visit.job ?? {}, {});
        const techs = technicians([visit]);
        const merged: NormalizedJob = {
          ...job,
          technicians: techs.length ? techs : job.technicians,
          scheduledStart: toIso(visit.startAt) ?? job.scheduledStart,
          scheduledEnd: toIso(visit.endAt) ?? job.scheduledEnd,
        };
        if (topic === 'VISIT_COMPLETE' || visit.completedAt) {
          return [
            makeEvent(SOURCE, 'job.completed', { ...merged, status: 'completed', completedAt: toIso(visit.completedAt) ?? d.occurredAt }, meta),
          ];
        }
        if (techs.length) {
          return [makeEvent(SOURCE, 'job.dispatched', { ...merged, status: 'dispatched', dispatchedAt: d.occurredAt }, meta)];
        }
        return [makeEvent(SOURCE, 'job.scheduled', { ...merged, status: 'scheduled' }, meta)];
      }
      case 'QUOTE_CREATE':
        return [makeEvent(SOURCE, 'estimate.created', jobberQuote(node), meta)];
      case 'QUOTE_SENT':
        return [makeEvent(SOURCE, 'estimate.sent', { ...jobberQuote(node), status: 'sent' }, meta)];
      case 'QUOTE_APPROVED': {
        const q = jobberQuote(node);
        return [makeEvent(SOURCE, 'estimate.approved', { ...q, status: 'approved', approvedAt: q.approvedAt ?? d.occurredAt }, meta)];
      }
      case 'QUOTE_UPDATE': {
        const q = jobberQuote(node);
        const type: EventType = q.status === 'approved' ? 'estimate.approved' : q.status === 'declined' ? 'estimate.declined' : q.status === 'sent' ? 'estimate.sent' : 'estimate.created';
        return [makeEvent(SOURCE, type, q, meta)];
      }
      case 'INVOICE_CREATE':
        return [makeEvent(SOURCE, 'invoice.created', jobberInvoice(node), meta)];
      case 'INVOICE_UPDATE': {
        const inv = jobberInvoice(node);
        return [makeEvent(SOURCE, invoiceEventType(inv), inv, meta)];
      }
      case 'PAYMENT_CREATE':
      case 'PAYMENT_UPDATE': {
        // Payment nodes reference their invoice; the invoice balance decides paid vs partial.
        const invoiceNode = isRecord(node.invoice) ? node.invoice : null;
        if (!invoiceNode) return [];
        const inv = jobberInvoice({ ...invoiceNode, client: invoiceNode.client ?? node.client });
        const paidAt = toIso(node.entryDate ?? node.createdAt) ?? d.occurredAt;
        return [makeEvent(SOURCE, invoiceEventType(inv), { ...inv, paidAt: inv.status === 'paid' ? (inv.paidAt ?? paidAt) : null }, meta)];
      }
      default:
        return [];
    }
  },

  normalizeRecord(kind: EntityKind, record) {
    switch (kind) {
      case 'customer':
        return jobberCustomer(record);
      case 'job':
        return jobberJob(record);
      case 'estimate':
        return jobberQuote(record);
      case 'invoice':
        return jobberInvoice(record);
    }
  },
};

/** GraphQL documents used to hydrate thin Jobber webhooks. */
const CLIENT_FIELDS = `id firstName lastName companyName name createdAt
  emails { address primary description }
  phones { number primary description smsAllowed }
  billingAddress { street1 street2 city province postalCode country }
  tags { nodes { label } }`;

export const JOBBER_HYDRATION_QUERIES: Record<HydrationKind, string> = {
  customer: `query BridgeClient($id: EncodedId!) { client(id: $id) { ${CLIENT_FIELDS} } }`,
  job: `query BridgeJob($id: EncodedId!) { job(id: $id) { id jobNumber title jobStatus total startAt endAt completedAt
    client { ${CLIENT_FIELDS} }
    property { address { street1 street2 city province postalCode country } }
    visits(first: 5) { nodes { id startAt endAt completedAt assignedUsers { nodes { id name { full } } } } } } }`,
  estimate: `query BridgeQuote($id: EncodedId!) { quote(id: $id) { id quoteNumber title quoteStatus createdAt
    amounts { total } client { ${CLIENT_FIELDS} } jobs(first: 1) { nodes { id } } } }`,
  invoice: `query BridgeInvoice($id: EncodedId!) { invoice(id: $id) { id invoiceNumber invoiceStatus issuedDate dueDate receivedDate
    amounts { total invoiceBalance paymentsTotal } client { ${CLIENT_FIELDS} } jobs(first: 1) { nodes { id } } } }`,
  visit: `query BridgeVisit($id: EncodedId!) { visit(id: $id) { id title startAt endAt completedAt
    assignedUsers { nodes { id name { full } } }
    job { id jobNumber title jobStatus total client { ${CLIENT_FIELDS} } property { address { street1 city province postalCode country } } } } }`,
  payment: `query BridgePayment($id: EncodedId!) { paymentRecord(id: $id) { id amount entryDate
    invoice { id invoiceNumber invoiceStatus amounts { total invoiceBalance paymentsTotal } client { ${CLIENT_FIELDS} } jobs(first: 1) { nodes { id } } } } }`,
};

const ROOT_FIELD: Record<HydrationKind, string> = {
  customer: 'client',
  job: 'job',
  estimate: 'quote',
  invoice: 'invoice',
  visit: 'visit',
  payment: 'paymentRecord',
};

export interface JobberClientOptions {
  accessToken: string;
  endpoint?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

/** Fetches the resource referenced by a thin Jobber webhook. */
export async function hydrateJobber(kind: HydrationKind, id: string, options: JobberClientOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(options.endpoint ?? 'https://api.getjobber.com/api/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.accessToken}`,
      'x-jobber-graphql-version': options.apiVersion ?? '2025-01-20',
    },
    body: JSON.stringify({ query: JOBBER_HYDRATION_QUERIES[kind], variables: { id } }),
  });
  if (!res.ok) throw new Error(`Jobber GraphQL HTTP ${res.status}`);
  const json = asRecord(await res.json());
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(`Jobber GraphQL error: ${String(asRecord(json.errors[0]).message ?? 'unknown')}`);
  }
  const node = asRecord(json.data)[ROOT_FIELD[kind]];
  if (!isRecord(node)) throw new Error(`Jobber ${kind} ${id} not found`);
  return node;
}
