import { describe, expect, it } from 'vitest';
import { housecallProNormalizer, type NormalizedEstimate, type NormalizedInvoice, type NormalizedJob } from '../../src/index.js';

const customer = {
  id: 'cus_abc',
  first_name: 'Derek',
  last_name: 'Thompson',
  email: 'Derek.T@Example.net',
  mobile_number: '512.555.0187',
  home_number: '(512) 555-0100',
  work_number: null,
  company: null,
  notifications_enabled: true,
  lead_source: 'Facebook Ads',
  tags: ['Repeat'],
  addresses: [{ street: '88 Rainey St', street_line_2: null, city: 'Austin', state: 'TX', zip: '78701', country: 'US' }],
};

const job = {
  id: 'job_123',
  invoice_number: '10442',
  description: 'Water heater replacement',
  customer,
  address: customer.addresses[0],
  work_status: 'complete unrated',
  work_timestamps: { on_my_way_at: '2025-05-01T14:00:00Z', started_at: '2025-05-01T14:30:00Z', completed_at: '2025-05-01T17:00:00Z' },
  schedule: { scheduled_start: '2025-05-01T14:00:00Z', scheduled_end: '2025-05-01T18:00:00Z' },
  total_amount: 189900,
  outstanding_balance: 189900,
  assigned_employees: [{ id: 'pro_1', first_name: 'Ben', last_name: 'Holloway' }],
  tags: [],
};

describe('Housecall Pro normalizer (REST, cents)', () => {
  it('job.completed keeps cents, prefers the mobile number, and maps timestamps', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({ event: 'job.completed', company_id: 'co_1', job });
    const j = evt!.entity as NormalizedJob;
    expect(evt!.type).toBe('job.completed');
    expect(evt!.accountId).toBe('co_1');
    expect(j.totalCents).toBe(189900);
    expect(j.customer?.phone).toBe('+15125550187');
    expect(j.customer?.phones).toEqual(['+15125550187', '+15125550100']);
    expect(j.customer?.email).toBe('derek.t@example.net');
    expect(j.customer?.leadSource).toBe('Facebook Ads');
    expect(j).toMatchObject({ dispatchedAt: '2025-05-01T14:00:00.000Z', startedAt: '2025-05-01T14:30:00.000Z', completedAt: '2025-05-01T17:00:00.000Z' });
    expect(j.technicians).toEqual([{ externalId: 'pro_1', name: 'Ben Holloway' }]);
  });

  it('job.on_my_way → job.dispatched', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({ event: 'job.on_my_way', job: { ...job, work_status: 'scheduled' } });
    expect(evt!.type).toBe('job.dispatched');
    expect((evt!.entity as NormalizedJob).status).toBe('dispatched');
  });

  it('job.paid → invoice.paid derived from the job when outstanding balance is zero', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({ event: 'job.paid', job: { ...job, outstanding_balance: 0 }, invoice: { id: 'inv_1', amount: 189900, paid_at: '2025-05-02T09:00:00Z' } });
    const inv = evt!.entity as NormalizedInvoice;
    expect(evt!.type).toBe('invoice.paid');
    expect(inv).toMatchObject({ externalId: 'inv_1', totalCents: 189900, balanceCents: 0, amountPaidCents: 189900, jobExternalId: 'job_123', paidAt: '2025-05-02T09:00:00.000Z' });
    expect(inv.customer?.externalId).toBe('cus_abc');
  });

  it('job.paid with a remaining balance → invoice.partially_paid', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({ event: 'job.paid', job: { ...job, outstanding_balance: 50000 }, invoice: { id: 'inv_1', amount: 189900 } });
    expect(evt!.type).toBe('invoice.partially_paid');
  });

  it('estimate.option.approval_status_changed picks the approved option total', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({
      event: 'estimate.option.approval_status_changed',
      estimate: {
        id: 'est_1',
        estimate_number: '5001',
        customer,
        options: [
          { id: 'o1', name: 'Good', total_amount: 120000, approval_status: 'declined' },
          { id: 'o2', name: 'Best', total_amount: 245000, approval_status: 'approved', approved_at: '2025-04-30T12:00:00Z' },
        ],
      },
    });
    const est = evt!.entity as NormalizedEstimate;
    expect(evt!.type).toBe('estimate.approved');
    expect(est).toMatchObject({ totalCents: 245000, title: 'Best', approvedAt: '2025-04-30T12:00:00.000Z' });
  });

  it('all options declined → estimate.declined', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({
      event: 'estimate.option.approval_status_changed',
      estimate: { id: 'est_2', customer, options: [{ id: 'o1', total_amount: 1, approval_status: 'declined' }] },
    });
    expect(evt!.type).toBe('estimate.declined');
  });

  it('customer.created with notifications disabled → doNotContact', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({ event: 'customer.created', customer: { ...customer, notifications_enabled: false } });
    expect(evt!.type).toBe('customer.created');
    expect(evt!.entity).toMatchObject({ kind: 'customer', doNotContact: true, tags: ['repeat'] });
  });

  it('invoice.updated with status disputed → invoice.disputed', () => {
    const [evt] = housecallProNormalizer.normalizeWebhook({ event: 'invoice.updated', invoice: { id: 'inv_9', amount: 1000, due_amount: 1000, status: 'disputed', customer } });
    expect(evt!.type).toBe('invoice.disputed');
  });

  it('deleted customers and unknown events are ignored', () => {
    expect(housecallProNormalizer.normalizeWebhook({ event: 'customer.deleted', customer })).toEqual([]);
    expect(housecallProNormalizer.normalizeWebhook({ event: 'lead.created' })).toEqual([]);
  });

  it('uses the provider event id for idempotency', () => {
    expect(housecallProNormalizer.describe({ id: 'evt_77', event: 'job.completed', job }).deliveryId).toBe('evt_77');
  });

  it('rejects a body without an event name', () => {
    expect(() => housecallProNormalizer.describe({ job })).toThrow(/missing "event"/);
  });
});
