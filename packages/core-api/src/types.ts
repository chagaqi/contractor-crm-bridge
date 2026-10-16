/**
 * Unified event model shared by every FSM normalizer and every CRM shell.
 *
 * All money is integer cents. All timestamps are ISO-8601 UTC strings.
 * All phones are E.164 (or null when unparseable). All emails are lower-cased.
 */

export const FSM_SOURCES = ['jobber', 'housecallpro', 'servicetitan', 'fieldedge', 'buildertrend'] as const;
export type FsmSource = (typeof FSM_SOURCES)[number];

export function isFsmSource(value: unknown): value is FsmSource {
  return typeof value === 'string' && (FSM_SOURCES as readonly string[]).includes(value);
}

export interface NormalizedAddress {
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface NormalizedCustomer {
  kind: 'customer';
  source: FsmSource;
  /** Provider-native id, unique within `source`. */
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  companyName: string | null;
  /** E.164 primary phone (mobile preferred). */
  phone: string | null;
  /** All E.164 phones discovered on the record, primary first. */
  phones: string[];
  email: string | null;
  emails: string[];
  address: NormalizedAddress | null;
  leadSource: string | null;
  tags: string[];
  /** True when the FSM explicitly marks the customer as opted out of marketing/notifications. */
  doNotContact: boolean;
  createdAt: string | null;
}

export type JobStatus =
  | 'unscheduled'
  | 'scheduled'
  | 'dispatched'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'on_hold';

export interface NormalizedTechnician {
  externalId: string | null;
  name: string;
}

export interface NormalizedJob {
  kind: 'job';
  source: FsmSource;
  externalId: string;
  number: string | null;
  title: string | null;
  status: JobStatus;
  /** Status string exactly as the provider sent it, for debugging. */
  rawStatus: string | null;
  customer: NormalizedCustomer | null;
  customerExternalId: string | null;
  address: NormalizedAddress | null;
  technicians: NormalizedTechnician[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalCents: number;
  /** Customer-satisfaction score on a 1..5 scale when the FSM captures one. */
  satisfactionScore: number | null;
  /** Free-form flags from the FSM (callback, warranty, complaint, recall ...), lower-cased. */
  flags: string[];
  tags: string[];
}

export type EstimateStatus = 'draft' | 'sent' | 'approved' | 'declined' | 'expired';

export interface NormalizedEstimate {
  kind: 'estimate';
  source: FsmSource;
  externalId: string;
  number: string | null;
  title: string | null;
  status: EstimateStatus;
  rawStatus: string | null;
  customer: NormalizedCustomer | null;
  customerExternalId: string | null;
  jobExternalId: string | null;
  totalCents: number;
  approvedAt: string | null;
  createdAt: string | null;
}

export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'void' | 'disputed' | 'refunded' | 'overdue';

export interface NormalizedInvoice {
  kind: 'invoice';
  source: FsmSource;
  externalId: string;
  number: string | null;
  status: InvoiceStatus;
  rawStatus: string | null;
  customer: NormalizedCustomer | null;
  customerExternalId: string | null;
  jobExternalId: string | null;
  totalCents: number;
  amountPaidCents: number;
  balanceCents: number;
  paidAt: string | null;
  issuedAt: string | null;
  dueAt: string | null;
}

export type NormalizedEntity = NormalizedCustomer | NormalizedJob | NormalizedEstimate | NormalizedInvoice;

export const EVENT_TYPES = [
  'customer.created',
  'customer.updated',
  'job.created',
  'job.scheduled',
  'job.dispatched',
  'job.started',
  'job.completed',
  'job.cancelled',
  'job.updated',
  'estimate.created',
  'estimate.sent',
  'estimate.approved',
  'estimate.declined',
  'invoice.created',
  'invoice.sent',
  'invoice.paid',
  'invoice.partially_paid',
  'invoice.voided',
  'invoice.disputed',
  'invoice.refunded',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface NormalizedEvent<E extends NormalizedEntity = NormalizedEntity> {
  /** Deterministic id: `${source}:${type}:${entity.externalId}:${occurredAt}` hashed. */
  id: string;
  type: EventType;
  source: FsmSource;
  /** FSM account/tenant id the event belongs to. */
  accountId: string | null;
  occurredAt: string;
  entity: E;
  /** Provider event name exactly as received (e.g. `JOB_COMPLETE`, `job.completed`). */
  rawEventName: string;
}

/** CRM-facing automation triggers emitted by the engine after business rules run. */
export const TRIGGER_KEYS = [
  'estimate_approved',
  'technician_dispatched',
  'job_completed',
  'invoice_paid',
  'invoice_paid_high_value',
  'review_request_ready',
] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

export interface CustomerMetrics {
  lifetimeValueCents: number;
  totalInvoicedCents: number;
  outstandingCents: number;
  paidInvoiceCount: number;
  completedJobCount: number;
  averageTicketCents: number;
  firstJobAt: string | null;
  lastJobAt: string | null;
  lastReviewRequestAt: string | null;
}

export interface UnifiedContact {
  /** Bridge-wide contact id (stable across FSMs). */
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  companyName: string | null;
  phone: string | null;
  phones: string[];
  email: string | null;
  emails: string[];
  address: NormalizedAddress | null;
  leadSource: string | null;
  tags: string[];
  doNotContact: boolean;
  /** `${source}:${externalId}` keys linked to this contact. */
  externalIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TriggerPayload {
  key: TriggerKey;
  /** Stable id for idempotent CRM delivery. */
  id: string;
  occurredAt: string;
  source: FsmSource;
  contact: UnifiedContact;
  metrics: CustomerMetrics;
  event: NormalizedEvent;
  /** Flat, CRM-friendly field map (snake_case keys, primitive values) for workflow builders. */
  fields: Record<string, string | number | boolean | null>;
  review?: ReviewDecision;
}

export interface ReviewDecision {
  eligible: boolean;
  reasons: string[];
  channels: Array<'sms' | 'email'>;
  /** Suggested delay before sending, in minutes. */
  delayMinutes: number;
}
