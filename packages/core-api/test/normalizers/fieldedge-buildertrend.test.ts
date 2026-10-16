import { describe, expect, it } from 'vitest';
import { buildertrendNormalizer, fieldEdgeNormalizer, type NormalizedCustomer, type NormalizedEstimate, type NormalizedInvoice, type NormalizedJob } from '../../src/index.js';

describe('FieldEdge normalizer (PascalCase, .NET dates)', () => {
  const Customer = {
    CustomerId: 'C-1001',
    DisplayName: 'Tom O\'Neill',
    Phones: [{ Number: '469-555-0100', Type: 'Home' }, { Number: '1-469-555-0163', Type: 'Cell' }],
    Email: 'Tom.ONeill@Example.com',
    BillingAddress: { Address1: '300 Elm St', City: 'Dallas', State: 'TX', Zip: '75202' },
    LeadSource: 'Google Ads',
    CreatedDate: '/Date(1704067200000)/',
  };
  const env = (EventType: string, Data: unknown) => ({ EventId: `fe-${EventType}`, EventType, CompanyId: 'fe-co', Timestamp: '/Date(1746129600000)/', Data });

  it('parses .NET JSON dates, mobile-first phones and splits DisplayName', () => {
    const c = fieldEdgeNormalizer.normalizeRecord('customer', Customer) as NormalizedCustomer;
    expect(c).toMatchObject({ firstName: "Tom", lastName: "O'Neill", phone: '+14695550163', email: 'tom.oneill@example.com', createdAt: '2024-01-01T00:00:00.000Z' });
    expect(fieldEdgeNormalizer.describe(env('WorkOrder.Completed', {})).occurredAt).toBe('2025-05-01T20:00:00.000Z');
  });

  it('WorkOrder.Completed with IsCallback → completed job carrying a callback flag', () => {
    const [evt] = fieldEdgeNormalizer.normalizeWebhook(env('WorkOrder.Completed', { WorkOrderId: 'WO-1', Status: 'Completed', Customer, TotalAmount: 289.99, IsCallback: true, CompletedDate: '2025-05-01T19:00:00Z' }));
    const j = evt!.entity as NormalizedJob;
    expect(evt!.type).toBe('job.completed');
    expect(j).toMatchObject({ totalCents: 28999, status: 'completed' });
    expect(j.flags).toContain('callback');
  });

  it('WorkOrder.StatusChanged derives the event from Status', () => {
    expect(fieldEdgeNormalizer.normalizeWebhook(env('WorkOrder.StatusChanged', { WorkOrderId: 'WO-1', Status: 'Dispatched', Customer }))[0]!.type).toBe('job.dispatched');
    expect(fieldEdgeNormalizer.normalizeWebhook(env('WorkOrder.StatusChanged', { WorkOrderId: 'WO-1', Status: 'In Progress', Customer }))[0]!.type).toBe('job.started');
  });

  it('Estimate.Accepted → estimate.approved', () => {
    const [evt] = fieldEdgeNormalizer.normalizeWebhook(env('Estimate.Accepted', { EstimateId: 'E-1', Status: 'Accepted', Total: '3,400.00', WorkOrderId: 'WO-1', Customer }));
    expect(evt!.type).toBe('estimate.approved');
    expect(evt!.entity as NormalizedEstimate).toMatchObject({ totalCents: 340000, jobExternalId: 'WO-1' });
  });

  it('Invoice.Paid uses AmountPaid/BalanceDue', () => {
    const [evt] = fieldEdgeNormalizer.normalizeWebhook(env('Invoice.Paid', { InvoiceId: 'I-1', Total: 650, AmountPaid: 650, BalanceDue: 0, WorkOrderId: 'WO-1', Customer }));
    expect(evt!.type).toBe('invoice.paid');
    expect(evt!.entity as NormalizedInvoice).toMatchObject({ amountPaidCents: 65000, balanceCents: 0, jobExternalId: 'WO-1', paidAt: '2025-05-01T20:00:00.000Z' });
  });

  it('Invoice.Updated with Disputed status → invoice.disputed', () => {
    expect(fieldEdgeNormalizer.normalizeWebhook(env('Invoice.Updated', { InvoiceId: 'I-2', Status: 'Disputed', Total: 10, BalanceDue: 10, Customer }))[0]!.type).toBe('invoice.disputed');
  });

  it('ignores unknown event types', () => {
    expect(fieldEdgeNormalizer.normalizeWebhook(env('Agreement.Renewed', {}))).toEqual([]);
  });
});

describe('Buildertrend normalizer (construction projects)', () => {
  const owner = { id: 3001, first_name: 'Kenji', last_name: 'Watanabe', email: 'kenji.w@example.net', cell_phone: '(737) 555-0108', phone: '737-555-0199', street_address: '9 Lakeway Dr', city: 'Lakeway', state: 'TX', zip: '78734', lead_source: 'Angi' };
  const env = (event: string, data: unknown) => ({ delivery_id: `bt-${event}`, event, builder_id: 'b-1', timestamp: '2025-05-01T20:00:00Z', data });
  const job = { id: 5001, job_name: 'Kitchen remodel', job_number: 'BT-5001', status: 'open', owner, contract_price: 48250, actual_start: '2025-03-01T14:00:00Z', project_manager: { id: 9, name: 'Rachel Kim' } };

  it('job.closed → job.completed with contract price and owner as customer', () => {
    const [evt] = buildertrendNormalizer.normalizeWebhook(env('job.closed', { ...job, status: 'closed', actual_completion: '2025-04-30T22:00:00Z' }));
    const j = evt!.entity as NormalizedJob;
    expect(evt!.type).toBe('job.completed');
    expect(j).toMatchObject({ totalCents: 4825000, completedAt: '2025-04-30T22:00:00.000Z', title: 'Kitchen remodel' });
    expect(j.customer).toMatchObject({ phone: '+17375550108', phones: ['+17375550108', '+17375550199'], leadSource: 'Angi' });
  });

  it('schedule_item.assigned → job.dispatched with crew', () => {
    const [evt] = buildertrendNormalizer.normalizeWebhook(env('schedule_item.assigned', { id: 1, start_date: '2025-05-02T13:00:00Z', assignees: [{ id: 7, name: 'Framing crew A' }], job }));
    const j = evt!.entity as NormalizedJob;
    expect(evt!.type).toBe('job.dispatched');
    expect(j.technicians.map((t) => t.name)).toContain('Framing crew A');
    expect(j.scheduledStart).toBe('2025-05-02T13:00:00.000Z');
  });

  it('job.status_changed derives completed from actual_completion', () => {
    expect(buildertrendNormalizer.normalizeWebhook(env('job.status_changed', { ...job, actual_completion: '2025-04-30T22:00:00Z' }))[0]!.type).toBe('job.completed');
    expect(buildertrendNormalizer.normalizeWebhook(env('job.status_changed', job))[0]!.type).toBe('job.updated');
  });

  it('proposal.approved → estimate.approved using owner_price', () => {
    const [evt] = buildertrendNormalizer.normalizeWebhook(env('proposal.approved', { id: 7001, title: 'Kitchen proposal', status: 'approved', owner_price: 48250, job_id: 5001, owner, approved_date: '2025-02-20T18:00:00Z' }));
    expect(evt!.type).toBe('estimate.approved');
    expect(evt!.entity).toMatchObject({ totalCents: 4825000, jobExternalId: '5001', approvedAt: '2025-02-20T18:00:00.000Z' });
  });

  it('owner_invoice.paid with status paid and no amount_paid assumes full payment', () => {
    const [evt] = buildertrendNormalizer.normalizeWebhook(env('owner_invoice.paid', { id: 9001, status: 'paid', amount: 12062.5, job_id: 5001, owner }));
    expect(evt!.type).toBe('invoice.paid');
    expect(evt!.entity as NormalizedInvoice).toMatchObject({ totalCents: 1206250, amountPaidCents: 1206250, balanceCents: 0 });
  });

  it('owner_invoice.updated partially paid → invoice.partially_paid', () => {
    expect(buildertrendNormalizer.normalizeWebhook(env('owner_invoice.updated', { id: 9002, status: 'partially_paid', amount: 1000, amount_paid: 250, owner }))[0]!.type).toBe('invoice.partially_paid');
  });

  it('lead.created → customer.created; unknown events ignored', () => {
    expect(buildertrendNormalizer.normalizeWebhook(env('lead.created', owner))[0]!.type).toBe('customer.created');
    expect(buildertrendNormalizer.normalizeWebhook(env('daily_log.created', {}))).toEqual([]);
  });
});

describe('FieldEdge "Last, First" display names', () => {
  it('builds "First Last" from explicit fields and from a comma DisplayName', () => {
    const explicit = fieldEdgeNormalizer.normalizeRecord('customer', { CustomerId: 'C-9', FirstName: 'Aisha', LastName: 'Bello', DisplayName: 'Bello, Aisha' }) as NormalizedCustomer;
    expect(explicit.displayName).toBe('Aisha Bello');
    const comma = fieldEdgeNormalizer.normalizeRecord('customer', { CustomerId: 'C-10', DisplayName: 'Bello, Aisha' }) as NormalizedCustomer;
    expect(comma).toMatchObject({ firstName: 'Aisha', lastName: 'Bello' });
  });
});
