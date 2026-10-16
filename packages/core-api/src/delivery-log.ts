/**
 * Webhook delivery log — every inbound webhook gets one record with a step-by-step trail,
 * every CRM call it caused (with status codes and errors), and enough of the request to replay it.
 * This is the direct answer to the #1 complaint about existing FSM↔CRM sync apps: silent failures.
 */
import type { EventType, FsmSource, TriggerKey } from './types.js';
import { newId, nowIso } from './util.js';

export type DeliveryStatus = 'processed' | 'ignored' | 'duplicate' | 'rejected' | 'failed' | 'partial';

export interface DeliveryStep {
  at: string;
  step: string;
  ok: boolean;
  detail?: string;
}

export interface CrmCallLog {
  target: string;
  action: string;
  ok: boolean;
  attempts: number;
  durationMs: number;
  status?: number;
  externalId?: string;
  error?: string;
  detail?: string;
}

export interface DeliveryRecord {
  id: string;
  source: FsmSource;
  receivedAt: string;
  completedAt: string | null;
  durationMs: number;
  status: DeliveryStatus;
  signature: 'valid' | 'invalid' | 'skipped';
  simulated: boolean;
  replayOf: string | null;
  rawEventName: string | null;
  accountId: string | null;
  idempotencyKey: string | null;
  request: { headers: Record<string, string>; body: unknown };
  events: Array<{ id: string; type: EventType; entityId: string; kind: string }>;
  triggers: Array<{ id: string; key: TriggerKey; fired: boolean; reason?: string }>;
  contactId: string | null;
  steps: DeliveryStep[];
  crm: CrmCallLog[];
  error: string | null;
}

const SENSITIVE_HEADER = /authorization|cookie|signature|hmac|secret|token|api-key/i;

export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.join(', ') : v;
    out[k.toLowerCase()] = SENSITIVE_HEADER.test(k) ? `${value.slice(0, 6)}…[redacted]` : value;
  }
  return out;
}

export function startDelivery(source: FsmSource, init: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    id: newId('dlv'),
    source,
    receivedAt: nowIso(),
    completedAt: null,
    durationMs: 0,
    status: 'processed',
    signature: 'skipped',
    simulated: false,
    replayOf: null,
    rawEventName: null,
    accountId: null,
    idempotencyKey: null,
    request: { headers: {}, body: null },
    events: [],
    triggers: [],
    contactId: null,
    steps: [],
    crm: [],
    error: null,
    ...init,
  };
}

export function step(record: DeliveryRecord, name: string, ok: boolean, detail?: string): void {
  record.steps.push({ at: nowIso(), step: name, ok, ...(detail ? { detail } : {}) });
}

export interface DeliveryQuery {
  source?: FsmSource;
  status?: DeliveryStatus;
  contactId?: string;
  limit?: number;
}

export function filterDeliveries(records: DeliveryRecord[], q: DeliveryQuery): DeliveryRecord[] {
  return records
    .filter((r) => (!q.source || r.source === q.source) && (!q.status || r.status === q.status) && (!q.contactId || r.contactId === q.contactId))
    .slice(0, Math.max(1, Math.min(q.limit ?? 100, 1000)));
}

export interface DeliveryStats {
  total: number;
  byStatus: Record<DeliveryStatus, number>;
  crmCalls: number;
  crmFailures: number;
  lastFailure: { id: string; at: string; error: string } | null;
}

export function deliveryStats(records: DeliveryRecord[]): DeliveryStats {
  const byStatus: Record<DeliveryStatus, number> = { processed: 0, ignored: 0, duplicate: 0, rejected: 0, failed: 0, partial: 0 };
  let crmCalls = 0;
  let crmFailures = 0;
  let lastFailure: DeliveryStats['lastFailure'] = null;
  for (const r of records) {
    byStatus[r.status] += 1;
    crmCalls += r.crm.length;
    const failed = r.crm.filter((c) => !c.ok);
    crmFailures += failed.length;
    if (!lastFailure && (r.status === 'failed' || r.status === 'partial' || r.status === 'rejected')) {
      lastFailure = { id: r.id, at: r.receivedAt, error: r.error ?? failed[0]?.error ?? 'unknown error' };
    }
  }
  return { total: records.length, byStatus, crmCalls, crmFailures, lastFailure };
}
