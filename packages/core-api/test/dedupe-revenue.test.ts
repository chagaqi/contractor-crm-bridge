import { describe, expect, it } from 'vitest';
import { BridgeStore, buildCustomer, ContactResolver, RevenueLedger, type NormalizedInvoice, type NormalizedJob } from '../src/index.js';

const cust = (over: Partial<Parameters<typeof buildCustomer>[0]> = {}) =>
  buildCustomer({ source: 'jobber', externalId: 'c1', firstName: 'Maria', lastName: 'Gonzalez', phones: ['(512) 555-0142'], emails: ['maria@example.com'], ...over });

describe('ContactResolver — strict E.164 + email + external-id dedupe', () => {
  it('creates a contact on first sight and indexes every identity key', () => {
    const store = new BridgeStore();
    const r = new ContactResolver(store).resolve(cust());
    expect(r).toMatchObject({ created: true, matchedBy: 'created' });
    expect([...store.keyIndex.keys()].sort()).toEqual(['email:maria@example.com', 'ext:jobber:c1', 'phone:+15125550142']);
  });

  it('re-resolving the same FSM record matches by external id and never duplicates', () => {
    const resolver = new ContactResolver(new BridgeStore());
    const a = resolver.resolve(cust());
    const b = resolver.resolve(cust({ phones: ['737-555-0119'] }));
    expect(b).toMatchObject({ matchedBy: 'external_id', created: false });
    expect(b.contact.id).toBe(a.contact.id);
    expect(b.contact.phones).toEqual(['+15125550142', '+17375550119']);
    expect(b.changed).toContain('phones');
  });

  it('links the same person across FSMs by E.164 phone even when formatted differently', () => {
    const resolver = new ContactResolver(new BridgeStore());
    const a = resolver.resolve(cust());
    const b = resolver.resolve(buildCustomer({ source: 'housecallpro', externalId: 'cus_9', firstName: 'Maria', lastName: 'Gonzalez', phones: ['+1 512.555.0142'] }));
    expect(b.matchedBy).toBe('phone');
    expect(b.contact.id).toBe(a.contact.id);
    expect(b.contact.externalIds).toEqual(['ext:jobber:c1', 'ext:housecallpro:cus_9']);
  });

  it('links across FSMs by email (case-insensitive) when no phone matches', () => {
    const resolver = new ContactResolver(new BridgeStore());
    const a = resolver.resolve(cust());
    const b = resolver.resolve(buildCustomer({ source: 'servicetitan', externalId: '41', displayName: 'M Gonzalez', emails: ['MARIA@example.com'], phones: ['214-555-0100'] }));
    expect(b.matchedBy).toBe('email');
    expect(b.contact.id).toBe(a.contact.id);
  });

  it('never matches on name alone', () => {
    const resolver = new ContactResolver(new BridgeStore());
    const a = resolver.resolve(cust());
    const b = resolver.resolve(buildCustomer({ source: 'fieldedge', externalId: 'C-1', firstName: 'Maria', lastName: 'Gonzalez', phones: ['214-555-0199'] }));
    expect(b.created).toBe(true);
    expect(b.contact.id).not.toBe(a.contact.id);
  });

  it('rejects a household merge: shared landline, different email, different record in the same FSM', () => {
    const resolver = new ContactResolver(new BridgeStore());
    const husband = resolver.resolve(cust({ externalId: 'c1', firstName: 'Tom', emails: ['tom@example.com'] }));
    const wife = resolver.resolve(cust({ externalId: 'c2', firstName: 'Ana', emails: ['ana@example.com'] }));
    expect(wife.created).toBe(true);
    expect(wife.contact.id).not.toBe(husband.contact.id);
    expect(wife.notes.join(' ')).toMatch(/household/);
  });

  it('does not overwrite known values with nulls, and propagates opt-outs', () => {
    const resolver = new ContactResolver(new BridgeStore());
    resolver.resolve(cust({ leadSource: 'Google LSA' }));
    const r = resolver.resolve(cust({ firstName: null, lastName: null, leadSource: null, doNotContact: true }));
    expect(r.contact).toMatchObject({ firstName: 'Maria', lastName: 'Gonzalez', leadSource: 'Google LSA', doNotContact: true });
  });
});

const job = (over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  kind: 'job', source: 'jobber', externalId: 'j1', number: '1', title: 'Job', status: 'completed', rawStatus: null, customer: null, customerExternalId: 'c1',
  address: null, technicians: [], scheduledStart: null, scheduledEnd: null, dispatchedAt: null, startedAt: null, completedAt: '2025-05-01T00:00:00.000Z',
  totalCents: 65000, satisfactionScore: null, flags: [], tags: [], ...over,
});
const invoice = (over: Partial<NormalizedInvoice> = {}): NormalizedInvoice => ({
  kind: 'invoice', source: 'jobber', externalId: 'i1', number: '1', status: 'paid', rawStatus: null, customer: null, customerExternalId: 'c1', jobExternalId: 'j1',
  totalCents: 65000, amountPaidCents: 65000, balanceCents: 0, paidAt: '2025-05-02T00:00:00.000Z', issuedAt: null, dueAt: null, ...over,
});

describe('RevenueLedger — LTV & attribution', () => {
  it('computes LTV, average ticket and outstanding across invoices (void/refunded excluded)', () => {
    const store = new BridgeStore();
    const ledger = new RevenueLedger(store);
    ledger.recordJob('ct1', job());
    ledger.recordInvoice('ct1', invoice());
    ledger.recordInvoice('ct1', invoice({ externalId: 'i2', totalCents: 20000, amountPaidCents: 5000, balanceCents: 15000, status: 'partial' }));
    ledger.recordInvoice('ct1', invoice({ externalId: 'i3', status: 'void', totalCents: 99999, amountPaidCents: 0 }));
    ledger.recordInvoice('ct1', invoice({ externalId: 'i4', status: 'refunded', totalCents: 10000, amountPaidCents: 10000 }));
    expect(ledger.metrics('ct1')).toMatchObject({
      lifetimeValueCents: 70000,
      totalInvoicedCents: 85000,
      outstandingCents: 15000,
      paidInvoiceCount: 1,
      averageTicketCents: 70000,
      completedJobCount: 1,
      firstJobAt: '2025-05-01T00:00:00.000Z',
    });
  });

  it('never regresses a completed job when an older status webhook arrives late', () => {
    const ledger = new RevenueLedger(new BridgeStore());
    ledger.recordJob('ct1', job());
    ledger.recordJob('ct1', job({ status: 'dispatched', completedAt: null, flags: ['callback'] }));
    expect(ledger.getJob('jobber', 'j1')).toMatchObject({ status: 'completed', completedAt: '2025-05-01T00:00:00.000Z', flags: ['callback'] });
  });

  it('attributes revenue by lead source and by FSM', () => {
    const store = new BridgeStore();
    const resolver = new ContactResolver(store);
    const ledger = new RevenueLedger(store);
    const a = resolver.resolve(cust({ leadSource: 'Google LSA' })).contact;
    const b = resolver.resolve(buildCustomer({ source: 'housecallpro', externalId: 'h1', phones: ['737-555-0119'], leadSource: 'Facebook Ads' })).contact;
    ledger.recordInvoice(a.id, invoice());
    ledger.recordInvoice(b.id, invoice({ source: 'housecallpro', externalId: 'h-i1', totalCents: 120000, amountPaidCents: 120000 }));
    ledger.recordJob(b.id, job({ source: 'housecallpro', externalId: 'h-j1' }));
    const report = ledger.attribution();
    expect(report.totalRevenueCents).toBe(185000);
    expect(report.byLeadSource.map((r) => [r.key, r.revenueCents])).toEqual([['Facebook Ads', 120000], ['Google LSA', 65000]]);
    expect(report.bySource.find((r) => r.key === 'housecallpro')).toMatchObject({ completedJobs: 1, paidInvoices: 1, contacts: 1 });
  });
});
