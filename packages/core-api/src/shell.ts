/**
 * Shared contract + helpers for CRM marketplace shells.
 */
import type { CrmAdapter } from './crm.js';
import { externalKey } from './dedupe.js';
import type { BridgeEngine } from './engine.js';
import type { Router } from './http.js';
import { normalizeEmail, toE164 } from './phone.js';
import { runSimulation, SCENARIOS, type Scenario } from './simulator.js';
import { FSM_SOURCES, isFsmSource, type CustomerMetrics, type UnifiedContact } from './types.js';

export interface MarketplaceShell {
  readonly id: string;
  readonly label: string;
  readonly adapter: CrmAdapter;
  registerRoutes(router: Router): void;
  /** Machine-readable listing of the marketplace surface (triggers, actions, pages, URLs, scopes). */
  manifest(): Record<string, unknown>;
}

export interface ShellDeps {
  engine: BridgeEngine;
  publicUrl: string;
  fetchImpl?: typeof fetch;
  /** Secret used for OAuth state and session tokens. */
  appSecret: string;
}

export class ShellInputError extends Error {}

/** Shared "Fire FSM test event" action used by every CRM's workflow builder. */
export async function fireTestEvent(engine: BridgeEngine, inputs: Record<string, unknown>) {
  const source = String(inputs.source ?? inputs.fsm ?? 'jobber').toLowerCase().replace(/[\s_-]/g, '');
  const scenario = String(inputs.scenario ?? 'job_completed').toLowerCase().replace(/[\s-]/g, '_');
  if (!isFsmSource(source)) throw new ShellInputError(`source must be one of ${FSM_SOURCES.join(', ')}`);
  if (!SCENARIOS.includes(scenario as Scenario)) throw new ShellInputError(`scenario must be one of ${SCENARIOS.join(', ')}`);
  const amount = inputs.amount ?? inputs.amount_usd;
  const amountCents = amount === undefined || amount === '' ? undefined : Math.round(Number(amount) * 100);
  if (amountCents !== undefined && (!Number.isFinite(amountCents) || amountCents < 0)) throw new ShellInputError('amount must be a positive number');
  const persona = inputs.persona === undefined || inputs.persona === '' ? undefined : Number(inputs.persona);
  const { delivery, webhook } = await runSimulation(engine, {
    source,
    scenario: scenario as Scenario,
    jobRef: inputs.job_ref ? String(inputs.job_ref) : undefined,
    persona: persona !== undefined && Number.isInteger(persona) && persona >= 0 ? persona : undefined,
    amountCents,
  });
  return { delivery, jobRef: webhook.jobRef };
}

export function findContact(
  engine: BridgeEngine,
  q: { phone?: unknown; email?: unknown; contactId?: unknown; source?: unknown; externalId?: unknown },
): UnifiedContact | undefined {
  if (typeof q.contactId === 'string' && engine.store.contacts.has(q.contactId)) return engine.store.contacts.get(q.contactId);
  if (typeof q.source === 'string' && q.externalId !== undefined) {
    const hit = engine.contacts.findByKey(externalKey(q.source, String(q.externalId)));
    if (hit) return hit;
  }
  const phone = toE164(q.phone);
  if (phone) {
    const hit = engine.contacts.findByKey(`phone:${phone}`);
    if (hit) return hit;
  }
  const email = normalizeEmail(q.email);
  if (email) return engine.contacts.findByKey(`email:${email}`);
  return undefined;
}

export interface ContactSummary {
  found: boolean;
  contact_id: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  lifetime_value: number;
  completed_jobs: number;
  average_ticket: number;
  outstanding_balance: number;
  last_job_at: string | null;
  last_review_request_at: string | null;
  fsm_records: string;
}

export function summarizeContact(contact: UnifiedContact | undefined, metrics: CustomerMetrics | undefined): ContactSummary {
  return {
    found: Boolean(contact),
    contact_id: contact?.id ?? null,
    name: contact?.displayName ?? null,
    phone: contact?.phone ?? null,
    email: contact?.email ?? null,
    lifetime_value: (metrics?.lifetimeValueCents ?? 0) / 100,
    completed_jobs: metrics?.completedJobCount ?? 0,
    average_ticket: (metrics?.averageTicketCents ?? 0) / 100,
    outstanding_balance: (metrics?.outstandingCents ?? 0) / 100,
    last_job_at: metrics?.lastJobAt ?? null,
    last_review_request_at: metrics?.lastReviewRequestAt ?? null,
    fsm_records: contact?.externalIds.map((k) => k.replace(/^ext:/, '')).join(', ') ?? '',
  };
}

export const TRIGGER_LABELS: Record<string, { name: string; description: string }> = {
  estimate_approved: { name: 'FSM: Estimate Approved', description: 'A customer approved an estimate/quote/proposal in the field-service app.' },
  technician_dispatched: { name: 'FSM: Technician Dispatched', description: 'A technician or crew was assigned / is on the way.' },
  job_completed: { name: 'FSM: Job Completed', description: 'A job / work order / visit was marked complete.' },
  invoice_paid: { name: 'FSM: Invoice Paid', description: 'An invoice was paid in full.' },
  invoice_paid_high_value: { name: 'FSM: Invoice Paid (High Value)', description: 'An invoice at or above the high-value threshold (default $500) was paid in full.' },
  review_request_ready: { name: 'FSM: Review Request Ready', description: 'Job is Completed & Paid and passed the Smart Review-Gate — send the Google review SMS/email now.' },
};
