import { collectEmails, collectPhones } from '../phone.js';
import type {
  EventType,
  FsmSource,
  NormalizedAddress,
  NormalizedCustomer,
  NormalizedEntity,
  NormalizedEvent,
} from '../types.js';
import { lowerList, stableId, str, toIso } from '../util.js';

export type EntityKind = 'customer' | 'job' | 'estimate' | 'invoice';
export type HydrationKind = EntityKind | 'visit' | 'payment';

export interface HydrationRequest {
  kind: HydrationKind;
  id: string;
  accountId: string | null;
}

export interface WebhookDescriptor {
  rawEventName: string;
  accountId: string | null;
  /** Provider-supplied unique delivery/event id, used for idempotency when present. */
  deliveryId: string | null;
  occurredAt: string | null;
  /** Set when the webhook only references a resource that must be fetched (Jobber). */
  hydrate: HydrationRequest | null;
}

export interface FsmNormalizer {
  source: FsmSource;
  /** Lightweight inspection of a webhook body (no business logic). */
  describe(body: unknown): WebhookDescriptor;
  /** Converts a webhook body (plus optional hydrated resource) into normalized events. Unknown events → []. */
  normalizeWebhook(body: unknown, hydrated?: unknown): NormalizedEvent[];
  /** Converts a REST/GraphQL API record into a normalized entity (used for backfills and hydration). */
  normalizeRecord(kind: EntityKind, record: unknown): NormalizedEntity;
}

export class NormalizationError extends Error {
  constructor(
    message: string,
    readonly source: FsmSource,
  ) {
    super(message);
    this.name = 'NormalizationError';
  }
}

export interface CustomerInput {
  source: FsmSource;
  externalId: unknown;
  firstName?: unknown;
  lastName?: unknown;
  displayName?: unknown;
  companyName?: unknown;
  /** Ordered by preference: mobile first. */
  phones?: unknown[];
  emails?: unknown[];
  address?: NormalizedAddress | null;
  leadSource?: unknown;
  tags?: unknown;
  doNotContact?: boolean;
  createdAt?: unknown;
}

export function buildCustomer(input: CustomerInput): NormalizedCustomer {
  const externalId = str(input.externalId);
  if (!externalId) throw new NormalizationError('customer is missing an id', input.source);
  const firstName = str(input.firstName);
  const lastName = str(input.lastName);
  const companyName = str(input.companyName);
  const phones = collectPhones(input.phones ?? []);
  const emails = collectEmails(input.emails ?? []);
  const displayName =
    str(input.displayName) ??
    ([firstName, lastName].filter(Boolean).join(' ') || companyName || emails[0] || phones[0] || `Customer ${externalId}`);
  return {
    kind: 'customer',
    source: input.source,
    externalId,
    firstName,
    lastName,
    displayName,
    companyName,
    phone: phones[0] ?? null,
    phones,
    email: emails[0] ?? null,
    emails,
    address: input.address ?? null,
    leadSource: str(input.leadSource),
    tags: lowerList(input.tags),
    doNotContact: input.doNotContact ?? false,
    createdAt: toIso(input.createdAt),
  };
}

export function makeEvent<E extends NormalizedEntity>(
  source: FsmSource,
  type: EventType,
  entity: E,
  meta: { accountId: string | null; occurredAt: string | null; rawEventName: string },
): NormalizedEvent<E> {
  const occurredAt = meta.occurredAt ?? new Date().toISOString();
  return {
    id: stableId('evt', source, type, entity.externalId, occurredAt),
    type,
    source,
    accountId: meta.accountId,
    occurredAt,
    entity,
    rawEventName: meta.rawEventName,
  };
}

/** Clamp a rating to the 1..5 scale; accepts 0..10 NPS-style scores too. */
export function normalizeScore(value: unknown, scale: 5 | 10 = 5): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  const five = scale === 10 ? n / 2 : n;
  return Math.max(1, Math.min(5, Math.round(five * 10) / 10));
}

export const NEGATIVE_FLAGS = ['callback', 'recall', 'warranty', 'complaint', 'dispute', 'disputed', 'unhappy', 'refund', 'chargeback', 'escalation', 'bad review risk'];

export function detectFlags(...sources: unknown[]): string[] {
  const flags: string[] = [];
  for (const source of sources) {
    for (const value of lowerList(source)) {
      for (const flag of NEGATIVE_FLAGS) {
        if (value.includes(flag) && !flags.includes(flag)) flags.push(flag);
      }
    }
  }
  return flags;
}
