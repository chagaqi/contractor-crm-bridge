/**
 * Smart Review-Gate.
 *
 * A Google-review request is only fired when *every* rule passes:
 *   1. The job is Completed.
 *   2. The job is Paid — every invoice for the job has a zero balance (and at least one exists).
 *   3. No negative signal on the job: callback / recall / warranty / complaint / dispute flags.
 *   4. No disputed, refunded or charged-back invoice for this customer (any FSM).
 *   5. The customer's satisfaction score (when the FSM captures one) is >= `minSatisfaction`.
 *   6. The customer is not opted out (`doNotContact`) and is not tagged with an exclusion tag.
 *   7. The customer has a reachable channel (E.164 phone for SMS and/or email).
 *   8. The customer has not been asked within `cooldownDays`, and this job has not already triggered a request.
 *   9. The paid amount is >= `minInvoiceCents`.
 *
 * The gate is pure: it receives a snapshot and returns a decision with human-readable reasons,
 * so the delivery log can explain *why* a review was or wasn't requested.
 */
import { NEGATIVE_FLAGS } from './normalizers/common.js';
import type { NormalizedInvoice, NormalizedJob, ReviewDecision, UnifiedContact } from './types.js';

export interface ReviewGateSettings {
  enabled: boolean;
  minSatisfaction: number;
  cooldownDays: number;
  minInvoiceCents: number;
  delayMinutes: number;
  excludeTags: string[];
  blockingFlags: string[];
  /** When false, a completed job with no invoice on file is still eligible (cash jobs invoiced elsewhere). */
  requireInvoice: boolean;
  channels: Array<'sms' | 'email'>;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewGateSettings = {
  enabled: true,
  minSatisfaction: 4,
  cooldownDays: 90,
  minInvoiceCents: 0,
  delayMinutes: 120,
  excludeTags: ['no-review', 'no review', 'do not review', 'vip-manual', 'commercial-no-review'],
  blockingFlags: NEGATIVE_FLAGS,
  requireInvoice: true,
  channels: ['sms', 'email'],
};

export interface ReviewGateInput {
  contact: UnifiedContact;
  job: NormalizedJob | undefined;
  jobInvoices: NormalizedInvoice[];
  contactInvoices: NormalizedInvoice[];
  lastReviewRequestAt: string | null;
  jobAlreadyReviewed: boolean;
  now?: Date;
}

const BAD_INVOICE: NormalizedInvoice['status'][] = ['disputed', 'refunded'];

export function evaluateReviewGate(input: ReviewGateInput, settings: ReviewGateSettings = DEFAULT_REVIEW_SETTINGS): ReviewDecision {
  const reasons: string[] = [];
  const { contact, job } = input;
  const now = input.now ?? new Date();

  if (!settings.enabled) reasons.push('review requests are disabled');

  if (!job) reasons.push('no job on file for this event');
  else if (job.status !== 'completed') reasons.push(`job status is ${job.status}, not completed`);

  const invoices = input.jobInvoices.filter((i) => i.status !== 'void' && i.status !== 'draft');
  if (settings.requireInvoice && invoices.length === 0) reasons.push('no invoice on file for this job');
  const unpaid = invoices.filter((i) => i.status !== 'paid' || i.balanceCents > 0);
  if (unpaid.length) reasons.push(`job has ${unpaid.length} unpaid invoice(s)`);
  const paidCents = invoices.reduce((sum, i) => sum + i.amountPaidCents, 0);
  if (paidCents < settings.minInvoiceCents) {
    reasons.push(`paid amount ${(paidCents / 100).toFixed(2)} below minimum ${(settings.minInvoiceCents / 100).toFixed(2)}`);
  }

  const blocking = (job?.flags ?? []).filter((f) => settings.blockingFlags.some((b) => f.includes(b)));
  if (blocking.length) reasons.push(`job flagged: ${blocking.join(', ')}`);

  const disputed = input.contactInvoices.filter((i) => BAD_INVOICE.includes(i.status));
  if (disputed.length) reasons.push(`customer has ${disputed.length} disputed/refunded invoice(s)`);

  if (job?.satisfactionScore !== null && job?.satisfactionScore !== undefined && job.satisfactionScore < settings.minSatisfaction) {
    reasons.push(`satisfaction score ${job.satisfactionScore} below ${settings.minSatisfaction}`);
  }

  if (contact.doNotContact) reasons.push('customer opted out of contact');
  const excluded = contact.tags.filter((t) => settings.excludeTags.includes(t.toLowerCase()));
  if (excluded.length) reasons.push(`customer tagged ${excluded.join(', ')}`);

  const channels: Array<'sms' | 'email'> = [];
  if (settings.channels.includes('sms') && contact.phone) channels.push('sms');
  if (settings.channels.includes('email') && contact.email) channels.push('email');
  if (!channels.length) reasons.push('no reachable phone or email');

  if (input.jobAlreadyReviewed) reasons.push('review already requested for this job');
  if (input.lastReviewRequestAt) {
    const days = (now.getTime() - new Date(input.lastReviewRequestAt).getTime()) / 86_400_000;
    if (days < settings.cooldownDays) reasons.push(`last review request ${Math.floor(days)} day(s) ago (cooldown ${settings.cooldownDays})`);
  }

  const eligible = reasons.length === 0;
  return {
    eligible,
    reasons: eligible ? ['completed & paid, no negative signals'] : reasons,
    channels: eligible ? channels : [],
    delayMinutes: settings.delayMinutes,
  };
}
