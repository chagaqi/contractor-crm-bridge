import { describe, expect, it } from 'vitest';
import { serviceTitanNormalizer, type NormalizedCustomer, type NormalizedEstimate, type NormalizedInvoice, type NormalizedJob } from '../../src/index.js';

const customer = {
  id: 41234567,
  name: 'Priya Raman',
  type: 'Residential',
  address: { street: '1201 Barton Springs Rd', unit: 'B', city: 'Austin', state: 'TX', zip: '78704', country: 'USA' },
  contacts: [
    { type: 'Phone', value: '737-555-0100' },
    { type: 'MobilePhone', value: '+1 737 555 0119' },
    { type: 'Email', value: 'PRaman@Example.org' },
  ],
  campaign: { name: 'Referral' },
  doNotMail: false,
  doNotService: false,
};

const env = (eventType: string, data: unknown) => ({ eventId: `st-${eventType}`, eventType, tenantId: '1234567', createdOn: '2025-05-01T20:00:00Z', data });

describe('ServiceTitan normalizer (REST v2, dollars)', () => {
  it('splits residential names, prefers MobilePhone contacts, maps campaign → lead source', () => {
    const c = serviceTitanNormalizer.normalizeRecord('customer', customer) as NormalizedCustomer;
    expect(c).toMatchObject({ firstName: 'Priya', lastName: 'Raman', phone: '+17375550119', email: 'praman@example.org', leadSource: 'Referral', companyName: null });
    expect(c.address?.street).toBe('1201 Barton Springs Rd, B');
  });

  it('commercial customers keep the name as companyName', () => {
    const c = serviceTitanNormalizer.normalizeRecord('customer', { ...customer, type: 'Commercial', name: 'Acme Property Mgmt' }) as NormalizedCustomer;
    expect(c).toMatchObject({ companyName: 'Acme Property Mgmt', firstName: null, displayName: 'Acme Property Mgmt' });
  });

  it('JobCompleted → job.completed with recall flag and survey score', () => {
    const [evt] = serviceTitanNormalizer.normalizeWebhook(
      env('JobCompleted', { id: 60001, jobNumber: '60001', customer, jobStatus: 'Completed', completedOn: '2025-05-01T19:30:00Z', total: 412.5, recallForId: 59000, customerSatisfactionScore: 9, surveyScale: 10 }),
    );
    const j = evt!.entity as NormalizedJob;
    expect(evt!.type).toBe('job.completed');
    expect(evt!.accountId).toBe('1234567');
    expect(j).toMatchObject({ totalCents: 41250, status: 'completed', completedAt: '2025-05-01T19:30:00.000Z', satisfactionScore: 4.5 });
    expect(j.flags).toContain('recall');
  });

  it('TechnicianDispatched wraps the job and attaches the technician', () => {
    const [evt] = serviceTitanNormalizer.normalizeWebhook(
      env('TechnicianDispatched', { technicianId: 7001, technicianName: 'Luis Ortega', dispatchedOn: '2025-05-01T15:00:00Z', job: { id: 60001, customer, jobStatus: 'Dispatched' } }),
    );
    const j = evt!.entity as NormalizedJob;
    expect(evt!.type).toBe('job.dispatched');
    expect(j.technicians).toEqual([{ externalId: '7001', name: 'Luis Ortega' }]);
    expect(j.dispatchedAt).toBe('2025-05-01T15:00:00.000Z');
  });

  it('EstimateSold → estimate.approved (subtotal + tax)', () => {
    const [evt] = serviceTitanNormalizer.normalizeWebhook(env('EstimateSold', { id: 8001, jobId: 60001, name: 'Heat pump', status: { value: 1, name: 'Sold' }, subtotal: 11800, tax: 200, soldOn: '2025-04-28T16:00:00Z', customer }));
    const e = evt!.entity as NormalizedEstimate;
    expect(evt!.type).toBe('estimate.approved');
    expect(e).toMatchObject({ totalCents: 1200000, jobExternalId: '60001', approvedAt: '2025-04-28T16:00:00.000Z' });
  });

  it('InvoicePaid with string decimals and zero balance → invoice.paid linked to the job', () => {
    const [evt] = serviceTitanNormalizer.normalizeWebhook(env('InvoicePaid', { id: 9001, referenceNumber: '60001', total: '1,250.00', balance: '0.00', customer: { id: 41234567, name: 'Priya Raman' }, job: { id: 60001, number: '60001' } }));
    const inv = evt!.entity as NormalizedInvoice;
    expect(evt!.type).toBe('invoice.paid');
    expect(inv).toMatchObject({ totalCents: 125000, balanceCents: 0, amountPaidCents: 125000, jobExternalId: '60001', customerExternalId: '41234567', paidAt: '2025-05-01T20:00:00.000Z' });
  });

  it('InvoiceUpdated with a partial balance → invoice.partially_paid', () => {
    const [evt] = serviceTitanNormalizer.normalizeWebhook(env('InvoiceUpdated', { id: 9002, total: 1000, balance: 400, customer: { id: 1 } }));
    expect(evt!.type).toBe('invoice.partially_paid');
  });

  it('accepts the v2 `__eventInfo` envelope', () => {
    const body = { __eventInfo: { eventId: 'abc', webhookType: 'JobCompleted', tenantId: '99' }, id: 1, customer, jobStatus: 'Completed' };
    const d = serviceTitanNormalizer.describe(body);
    expect(d).toMatchObject({ rawEventName: 'JobCompleted', deliveryId: 'abc', accountId: '99' });
    expect(serviceTitanNormalizer.normalizeWebhook(body)[0]!.type).toBe('job.completed');
  });

  it('doNotService customers are flagged doNotContact', () => {
    expect((serviceTitanNormalizer.normalizeRecord('customer', { ...customer, doNotService: true }) as NormalizedCustomer).doNotContact).toBe(true);
  });

  it('unmapped event types are ignored', () => {
    expect(serviceTitanNormalizer.normalizeWebhook(env('MembershipRenewed', { id: 1 }))).toEqual([]);
  });
});
