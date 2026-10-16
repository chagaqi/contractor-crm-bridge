import { describe, expect, it } from 'vitest';
import { hydrateJobber, jobberNormalizer, JOBBER_HYDRATION_QUERIES, NormalizationError, type NormalizedInvoice, type NormalizedJob } from '../../src/index.js';
import { mockFetch } from '../helpers.js';

const client = {
  id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x',
  firstName: 'Maria',
  lastName: 'Gonzalez',
  companyName: null,
  emails: { nodes: [{ address: 'old@example.com', primary: false }, { address: 'Maria.Gonzalez@Example.com', primary: true }] },
  phones: { nodes: [{ number: '512-555-0100', primary: false, description: 'Home' }, { number: '(512) 555-0142', primary: true, description: 'Mobile' }] },
  billingAddress: { street1: '4100 Speedway', street2: 'Unit 2', city: 'Austin', province: 'TX', postalCode: '78751', country: 'US' },
  tags: { nodes: [{ label: 'VIP' }] },
  createdAt: '2024-03-02T15:00:00Z',
};

const thin = (topic: string, itemId = 'Z2lkOi8vSm9iYmVyL0pvYi8x') => ({
  data: { webHookEvent: { topic, appId: 'app', accountId: 'acct_1', itemId, occurredAt: '2025-05-01T18:00:00-05:00' } },
});

const jobNode = {
  id: 'Z2lkOi8vSm9iYmVyL0pvYi8x',
  jobNumber: 1042,
  title: 'Spring lawn aeration',
  jobStatus: 'requires_invoicing',
  total: 650,
  completedAt: '2025-05-01T22:55:00Z',
  client,
  property: { address: { street1: '4100 Speedway', city: 'Austin', province: 'TX', postalCode: '78751', country: 'US' } },
  visits: { nodes: [{ id: 'v1', startAt: '2025-05-01T20:00:00Z', assignedUsers: { nodes: [{ id: 'u1', name: { full: 'Luis Ortega' } }] } }] },
  customFields: [{ label: 'Customer satisfaction', valueNumeric: 5 }],
};

describe('Jobber normalizer (GraphQL)', () => {
  it('describes a thin webhook and requests hydration by topic prefix', () => {
    expect(jobberNormalizer.describe(thin('JOB_COMPLETE'))).toMatchObject({
      rawEventName: 'JOB_COMPLETE',
      accountId: 'acct_1',
      occurredAt: '2025-05-01T23:00:00.000Z',
      hydrate: { kind: 'job', id: 'Z2lkOi8vSm9iYmVyL0pvYi8x' },
    });
    expect(jobberNormalizer.describe(thin('QUOTE_APPROVED')).hydrate?.kind).toBe('estimate');
    expect(jobberNormalizer.describe(thin('VISIT_UPDATE')).hydrate?.kind).toBe('visit');
    expect(jobberNormalizer.describe(thin('PAYMENT_CREATE')).hydrate?.kind).toBe('payment');
  });

  it('throws when a thin webhook is normalized without its hydrated node', () => {
    expect(() => jobberNormalizer.normalizeWebhook(thin('JOB_COMPLETE'))).toThrow(NormalizationError);
  });

  it('JOB_COMPLETE → job.completed with primary-mobile phone, primary email, technicians and dollars→cents', () => {
    const [evt] = jobberNormalizer.normalizeWebhook(thin('JOB_COMPLETE'), jobNode);
    const job = evt!.entity as NormalizedJob;
    expect(evt!.type).toBe('job.completed');
    expect(job.status).toBe('completed');
    expect(job.totalCents).toBe(65000);
    expect(job.number).toBe('1042');
    expect(job.technicians).toEqual([{ externalId: 'u1', name: 'Luis Ortega' }]);
    expect(job.satisfactionScore).toBe(5);
    expect(job.customer).toMatchObject({
      phone: '+15125550142',
      phones: ['+15125550142', '+15125550100'],
      email: 'maria.gonzalez@example.com',
      address: { street: '4100 Speedway, Unit 2', city: 'Austin', region: 'TX', postalCode: '78751', country: 'US' },
      tags: ['vip'],
    });
  });

  it('VISIT_UPDATE with assigned users → job.dispatched', () => {
    const visit = { id: 'v1', startAt: '2025-05-01T20:00:00Z', assignedUsers: { nodes: [{ id: 'u2', name: { full: 'Jasmine Carter' } }] }, job: { ...jobNode, jobStatus: 'upcoming', completedAt: null, visits: [] } };
    const [evt] = jobberNormalizer.normalizeWebhook(thin('VISIT_UPDATE', 'v1'), visit);
    expect(evt!.type).toBe('job.dispatched');
    expect((evt!.entity as NormalizedJob).technicians[0]!.name).toBe('Jasmine Carter');
    expect((evt!.entity as NormalizedJob).dispatchedAt).toBe('2025-05-01T23:00:00.000Z');
  });

  it('QUOTE_APPROVED → estimate.approved linked to its job', () => {
    const quote = { id: 'q1', quoteNumber: 77, title: 'Gutter guards', quoteStatus: 'approved', amounts: { total: '1,250.00' }, client, jobs: { nodes: [{ id: 'j9' }] } };
    const [evt] = jobberNormalizer.normalizeWebhook(thin('QUOTE_APPROVED', 'q1'), quote);
    expect(evt!.type).toBe('estimate.approved');
    expect(evt!.entity).toMatchObject({ kind: 'estimate', totalCents: 125000, jobExternalId: 'j9', status: 'approved' });
  });

  it('INVOICE_UPDATE maps Jobber invoice statuses (paid / past_due / bad_debt)', () => {
    const inv = (invoiceStatus: string, balance: number, paid: number) => ({
      id: 'i1',
      invoiceNumber: 9,
      invoiceStatus,
      amounts: { total: 650, invoiceBalance: balance, paymentsTotal: paid },
      client,
      jobs: { nodes: [{ id: 'j1' }] },
    });
    const paid = jobberNormalizer.normalizeWebhook(thin('INVOICE_UPDATE', 'i1'), inv('paid', 0, 650))[0]!;
    expect(paid.type).toBe('invoice.paid');
    expect(paid.entity).toMatchObject({ amountPaidCents: 65000, balanceCents: 0, jobExternalId: 'j1' });
    expect(jobberNormalizer.normalizeWebhook(thin('INVOICE_UPDATE', 'i1'), inv('past_due', 300, 350))[0]!.type).toBe('invoice.partially_paid');
    expect((jobberNormalizer.normalizeWebhook(thin('INVOICE_UPDATE', 'i1'), inv('bad_debt', 650, 0))[0]!.entity as NormalizedInvoice).status).toBe('disputed');
  });

  it('PAYMENT_CREATE resolves through the payment record to its invoice', () => {
    const payment = { id: 'p1', amount: 650, entryDate: '2025-05-02T10:00:00Z', invoice: { id: 'i1', invoiceStatus: 'paid', amounts: { total: 650, invoiceBalance: 0 }, client } };
    const [evt] = jobberNormalizer.normalizeWebhook(thin('PAYMENT_CREATE', 'p1'), payment);
    expect(evt!.type).toBe('invoice.paid');
    expect((evt!.entity as NormalizedInvoice).paidAt).toBe('2025-05-02T10:00:00.000Z');
  });

  it('unknown topics normalize to no events', () => {
    expect(jobberNormalizer.normalizeWebhook(thin('APP_DISCONNECT'), { id: 'x' })).toEqual([]);
  });

  it('hydrateJobber posts the right GraphQL document with bearer auth and version header', async () => {
    const { fetch, calls } = mockFetch([{ match: 'graphql', reply: { data: { job: jobNode } } }]);
    const node = await hydrateJobber('job', 'J1', { accessToken: 'tok', fetchImpl: fetch });
    expect(node).toMatchObject({ id: jobNode.id });
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    expect(calls[0]!.headers['x-jobber-graphql-version']).toBeTruthy();
    expect(calls[0]!.body).toMatchObject({ query: JOBBER_HYDRATION_QUERIES.job, variables: { id: 'J1' } });
  });

  it('hydrateJobber surfaces GraphQL errors', async () => {
    const { fetch } = mockFetch([{ match: 'graphql', reply: { errors: [{ message: 'Throttled' }] } }]);
    await expect(hydrateJobber('job', 'J1', { accessToken: 'tok', fetchImpl: fetch })).rejects.toThrow('Throttled');
  });

  it('normalizeRecord maps REST/GraphQL records for backfills', () => {
    expect(jobberNormalizer.normalizeRecord('customer', client)).toMatchObject({ kind: 'customer', displayName: 'Maria Gonzalez', leadSource: null });
  });
});
