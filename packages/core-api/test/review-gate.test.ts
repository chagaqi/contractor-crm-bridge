import { describe, expect, it } from 'vitest';
import { DEFAULT_REVIEW_SETTINGS, evaluateReviewGate, type NormalizedInvoice, type NormalizedJob, type ReviewGateInput, type UnifiedContact } from '../src/index.js';

const contact = (over: Partial<UnifiedContact> = {}): UnifiedContact => ({
  id: 'ct1', firstName: 'Maria', lastName: 'Gonzalez', displayName: 'Maria Gonzalez', companyName: null, phone: '+15125550142', phones: ['+15125550142'],
  email: 'maria@example.com', emails: ['maria@example.com'], address: null, leadSource: null, tags: [], doNotContact: false, externalIds: ['ext:jobber:c1'],
  createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', ...over,
});
const job = (over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  kind: 'job', source: 'jobber', externalId: 'j1', number: '1', title: 'Job', status: 'completed', rawStatus: null, customer: null, customerExternalId: 'c1',
  address: null, technicians: [], scheduledStart: null, scheduledEnd: null, dispatchedAt: null, startedAt: null, completedAt: '2025-05-01T00:00:00Z',
  totalCents: 65000, satisfactionScore: null, flags: [], tags: [], ...over,
});
const paid = (over: Partial<NormalizedInvoice> = {}): NormalizedInvoice => ({
  kind: 'invoice', source: 'jobber', externalId: 'i1', number: '1', status: 'paid', rawStatus: null, customer: null, customerExternalId: 'c1', jobExternalId: 'j1',
  totalCents: 65000, amountPaidCents: 65000, balanceCents: 0, paidAt: '2025-05-02T00:00:00Z', issuedAt: null, dueAt: null, ...over,
});

const base = (over: Partial<ReviewGateInput> = {}): ReviewGateInput => ({
  contact: contact(),
  job: job(),
  jobInvoices: [paid()],
  contactInvoices: [paid()],
  lastReviewRequestAt: null,
  jobAlreadyReviewed: false,
  now: new Date('2025-05-03T00:00:00Z'),
  ...over,
});

describe('Smart Review-Gate', () => {
  it('ELIGIBLE: completed + paid + clean history → both channels', () => {
    expect(evaluateReviewGate(base())).toEqual({ eligible: true, reasons: ['completed & paid, no negative signals'], channels: ['sms', 'email'], delayMinutes: 120 });
  });

  it.each<[string, Partial<ReviewGateInput>, RegExp]>([
    ['job not completed', { job: job({ status: 'in_progress' }) }, /not completed/],
    ['no job on file', { job: undefined }, /no job on file/],
    ['no invoice on file', { jobInvoices: [] }, /no invoice on file/],
    ['invoice unpaid', { jobInvoices: [paid({ status: 'sent', amountPaidCents: 0, balanceCents: 65000 })] }, /unpaid invoice/],
    ['invoice partially paid', { jobInvoices: [paid({ status: 'partial', amountPaidCents: 30000, balanceCents: 35000 })] }, /unpaid invoice/],
    ['callback flag', { job: job({ flags: ['callback'] }) }, /flagged: callback/],
    ['warranty flag', { job: job({ flags: ['warranty'] }) }, /flagged: warranty/],
    ['complaint flag', { job: job({ flags: ['complaint'] }) }, /flagged: complaint/],
    ['disputed invoice on the account', { contactInvoices: [paid(), paid({ externalId: 'old', status: 'disputed' })] }, /disputed\/refunded/],
    ['refunded invoice on the account', { contactInvoices: [paid({ externalId: 'old', status: 'refunded' })] }, /disputed\/refunded/],
    ['low satisfaction', { job: job({ satisfactionScore: 3 }) }, /satisfaction score 3 below 4/],
    ['opted out', { contact: contact({ doNotContact: true }) }, /opted out/],
    ['exclusion tag', { contact: contact({ tags: ['no-review'] }) }, /tagged no-review/],
    ['no reachable channel', { contact: contact({ phone: null, email: null }) }, /no reachable/],
    ['within cooldown', { lastReviewRequestAt: '2025-04-01T00:00:00Z' }, /cooldown 90/],
    ['job already reviewed', { jobAlreadyReviewed: true }, /already requested/],
  ])('BLOCKED: %s', (_name, over, reason) => {
    const d = evaluateReviewGate(base(over));
    expect(d.eligible).toBe(false);
    expect(d.channels).toEqual([]);
    expect(d.reasons.join('; ')).toMatch(reason);
  });

  it('cooldown expires after the configured window', () => {
    expect(evaluateReviewGate(base({ lastReviewRequestAt: '2025-01-01T00:00:00Z' })).eligible).toBe(true);
  });

  it('satisfaction at the threshold passes; missing scores pass', () => {
    expect(evaluateReviewGate(base({ job: job({ satisfactionScore: 4 }) })).eligible).toBe(true);
    expect(evaluateReviewGate(base({ job: job({ satisfactionScore: null }) })).eligible).toBe(true);
  });

  it('respects minInvoiceCents and channel configuration', () => {
    const settings = { ...DEFAULT_REVIEW_SETTINGS, minInvoiceCents: 100_000 };
    expect(evaluateReviewGate(base(), settings).reasons.join()).toMatch(/below minimum 1000.00/);
    expect(evaluateReviewGate(base({ contact: contact({ email: null }) }), { ...DEFAULT_REVIEW_SETTINGS, channels: ['email'] }).reasons.join()).toMatch(/no reachable/);
    expect(evaluateReviewGate(base({ contact: contact({ email: null }) })).channels).toEqual(['sms']);
  });

  it('requireInvoice=false lets cash jobs through, but never unpaid ones', () => {
    const settings = { ...DEFAULT_REVIEW_SETTINGS, requireInvoice: false };
    expect(evaluateReviewGate(base({ jobInvoices: [] }), settings).eligible).toBe(true);
    expect(evaluateReviewGate(base({ jobInvoices: [paid({ status: 'sent', balanceCents: 1 })] }), settings).eligible).toBe(false);
  });

  it('collects every failing reason, not just the first', () => {
    const d = evaluateReviewGate(base({ job: job({ status: 'scheduled', flags: ['callback'] }), contact: contact({ doNotContact: true }) }));
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('can be disabled globally', () => {
    expect(evaluateReviewGate(base(), { ...DEFAULT_REVIEW_SETTINGS, enabled: false }).eligible).toBe(false);
  });
});
