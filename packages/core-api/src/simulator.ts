/**
 * FSM Sandbox Simulator — builds realistic, provider-shaped, *signed* webhooks so agencies can test
 * CRM workflows without a live technician. Simulated deliveries travel the exact same code path as
 * production webhooks (signature verification, hydration, normalization, dedupe, rules, CRM fan-out).
 */
import type { BridgeEngine } from './engine.js';
import type { DeliveryRecord } from './delivery-log.js';
import { signPayload } from './signatures.js';
import type { FsmSource } from './types.js';
import { sha256Hex } from './util.js';

export const SCENARIOS = [
  'customer_created',
  'estimate_approved',
  'technician_dispatched',
  'job_completed',
  'invoice_paid',
  'job_callback',
  'invoice_disputed',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const SCENARIO_LABELS: Record<Scenario, string> = {
  customer_created: 'New Customer',
  estimate_approved: 'Estimate Approved',
  technician_dispatched: 'Technician Dispatched',
  job_completed: 'Job Completed',
  invoice_paid: 'Invoice Paid',
  job_callback: 'Job Completed (callback / unhappy)',
  invoice_disputed: 'Invoice Disputed',
};

/** The happy-path lifecycle the playground's "Run full lifecycle" button fires, in order. */
export const LIFECYCLE: Scenario[] = ['estimate_approved', 'technician_dispatched', 'job_completed', 'invoice_paid'];

export interface Persona {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  leadSource: string;
}

export const PERSONAS: Persona[] = [
  { firstName: 'Maria', lastName: 'Gonzalez', phone: '(512) 555-0142', email: 'maria.gonzalez@example.com', street: '4100 Speedway', city: 'Austin', state: 'TX', zip: '78751', leadSource: 'Google Local Services' },
  { firstName: 'Derek', lastName: 'Thompson', phone: '512.555.0187', email: 'derek.t@example.net', street: '88 Rainey St', city: 'Austin', state: 'TX', zip: '78701', leadSource: 'Facebook Ads' },
  { firstName: 'Priya', lastName: 'Raman', phone: '+1 737 555 0119', email: 'PRaman@Example.org', street: '1201 Barton Springs Rd', city: 'Austin', state: 'TX', zip: '78704', leadSource: 'Referral' },
  { firstName: 'Tom', lastName: "O'Neill", phone: '1-469-555-0163', email: 'tom.oneill@example.com', street: '300 Elm St', city: 'Dallas', state: 'TX', zip: '75202', leadSource: 'Google Ads' },
  { firstName: 'Aisha', lastName: 'Bello', phone: '214-555-0171 ext 4', email: 'aisha.bello@example.com', street: '2700 Main St', city: 'Dallas', state: 'TX', zip: '75226', leadSource: 'Yard Sign' },
  { firstName: 'Kenji', lastName: 'Watanabe', phone: '(737) 555-0108', email: 'kenji.w@example.net', street: '9 Lakeway Dr', city: 'Lakeway', state: 'TX', zip: '78734', leadSource: 'Angi' },
];

const TRADES: Record<FsmSource, Array<{ title: string; estimate: string }>> = {
  jobber: [
    { title: 'Spring lawn aeration & overseed', estimate: 'Full-property lawn renovation' },
    { title: 'Gutter cleaning – 2 story', estimate: 'Gutter guard install' },
  ],
  housecallpro: [
    { title: 'Water heater replacement – 50 gal', estimate: 'Tankless water heater upgrade' },
    { title: 'Main line drain clearing', estimate: 'Sewer line camera + hydro-jet' },
  ],
  servicetitan: [
    { title: 'AC not cooling – diagnostic & repair', estimate: '16 SEER heat pump system replacement' },
    { title: 'Furnace tune-up', estimate: 'Indoor air quality package' },
  ],
  fieldedge: [
    { title: 'Electrical panel upgrade 200A', estimate: 'Whole-home surge + panel upgrade' },
    { title: 'No heat call', estimate: 'Gas furnace replacement' },
  ],
  buildertrend: [
    { title: 'Kitchen remodel – Gonzalez residence', estimate: 'Kitchen remodel proposal' },
    { title: 'Primary bath remodel', estimate: 'Bathroom remodel proposal' },
  ],
};

export interface SimulationRequest {
  source: FsmSource;
  scenario: Scenario;
  /** Ties events to the same job across scenarios. Defaults to a fresh job. */
  jobRef?: string;
  /** Persona index into PERSONAS, or a custom persona. */
  persona?: number | Persona;
  /** Invoice / estimate amount in cents. Defaults: invoice $650, estimate $1,250. */
  amountCents?: number;
  /** 1..5 satisfaction score to attach to the completed job. */
  satisfaction?: number;
  /** Override the clock (tests). */
  now?: Date;
}

export interface SimulatedWebhook {
  source: FsmSource;
  scenario: Scenario;
  jobRef: string;
  body: unknown;
  rawBody: string;
  headers: Record<string, string>;
  /** Hydration fixtures for thin webhooks (Jobber): `${source}:${kind}:${id}` → GraphQL node. */
  fixtures: Array<[string, unknown]>;
}

function seed(ref: string): number {
  return parseInt(sha256Hex(ref).slice(0, 8), 16);
}

function hex(ref: string, salt: string, len = 12): string {
  return sha256Hex(`${salt}:${ref}`).slice(0, len);
}

function gid(type: string, n: number): string {
  return Buffer.from(`gid://Jobber/${type}/${n}`).toString('base64');
}

const dollars = (cents: number) => Number((cents / 100).toFixed(2));

interface Ctx {
  ref: string;
  n: number;
  p: Persona;
  personaKey: string;
  job: { title: string; estimate: string };
  now: Date;
  iso: string;
  startIso: string;
  amount: number;
  estimateAmount: number;
  flags: string[];
  satisfaction: number | undefined;
  tech: { id: string; name: string };
}

const TECHS = [
  { id: '7001', name: 'Luis Ortega' },
  { id: '7002', name: 'Jasmine Carter' },
  { id: '7003', name: 'Ben Holloway' },
];

function build(source: FsmSource, scenario: Scenario, c: Ctx): { body: unknown; fixtures: Array<[string, unknown]> } {
  switch (source) {
    case 'jobber':
      return jobber(scenario, c);
    case 'housecallpro':
      return { body: housecallpro(scenario, c), fixtures: [] };
    case 'servicetitan':
      return { body: servicetitan(scenario, c), fixtures: [] };
    case 'fieldedge':
      return { body: fieldedge(scenario, c), fixtures: [] };
    case 'buildertrend':
      return { body: buildertrend(scenario, c), fixtures: [] };
  }
}

function jobber(scenario: Scenario, c: Ctx) {
  const clientN = seed(c.personaKey) % 900000;
  const jobN = c.n % 900000;
  const client = {
    id: gid('Client', clientN),
    firstName: c.p.firstName,
    lastName: c.p.lastName,
    companyName: null,
    createdAt: '2024-03-02T15:00:00Z',
    emails: { nodes: [{ address: c.p.email, primary: true, description: 'MAIN' }] },
    phones: { nodes: [{ number: c.p.phone, primary: true, description: 'Mobile', smsAllowed: true }] },
    billingAddress: { street1: c.p.street, street2: null, city: c.p.city, province: c.p.state, postalCode: c.p.zip, country: 'US' },
    leadSource: c.p.leadSource,
    tags: { nodes: [] },
  };
  const job = {
    id: gid('Job', jobN),
    jobNumber: 1000 + (jobN % 9000),
    title: c.job.title,
    jobStatus: 'upcoming',
    total: dollars(c.amount),
    startAt: c.startIso,
    endAt: null as string | null,
    completedAt: null as string | null,
    client,
    property: { address: { street1: c.p.street, city: c.p.city, province: c.p.state, postalCode: c.p.zip, country: 'US' } },
    tags: { nodes: c.flags.map((label) => ({ label })) },
    customFields: c.satisfaction ? [{ label: 'Customer satisfaction', valueNumeric: c.satisfaction }] : [],
    visits: { nodes: [] as unknown[] },
  };
  const assigned = { nodes: [{ id: gid('User', Number(c.tech.id)), name: { full: c.tech.name } }] };
  let topic: string;
  let kind: string;
  let node: Record<string, unknown>;
  switch (scenario) {
    case 'customer_created':
      topic = 'CLIENT_CREATE';
      kind = 'customer';
      node = client;
      break;
    case 'estimate_approved':
      topic = 'QUOTE_APPROVED';
      kind = 'estimate';
      node = {
        id: gid('Quote', jobN),
        quoteNumber: 500 + (jobN % 9000),
        title: c.job.estimate,
        quoteStatus: 'approved',
        createdAt: c.startIso,
        approvedAt: c.iso,
        amounts: { total: dollars(c.estimateAmount) },
        client,
        jobs: { nodes: [{ id: job.id }] },
      };
      break;
    case 'technician_dispatched':
      topic = 'VISIT_UPDATE';
      kind = 'visit';
      node = { id: gid('Visit', jobN), title: c.job.title, startAt: c.iso, endAt: null, completedAt: null, assignedUsers: assigned, job };
      break;
    case 'job_completed':
    case 'job_callback':
      topic = 'JOB_COMPLETE';
      kind = 'job';
      node = {
        ...job,
        jobStatus: 'requires_invoicing',
        completedAt: c.iso,
        visits: { nodes: [{ id: gid('Visit', jobN), startAt: c.startIso, completedAt: c.iso, assignedUsers: assigned }] },
      };
      break;
    case 'invoice_paid':
    case 'invoice_disputed':
      topic = 'INVOICE_UPDATE';
      kind = 'invoice';
      node = {
        id: gid('Invoice', jobN),
        invoiceNumber: 2000 + (jobN % 9000),
        invoiceStatus: scenario === 'invoice_paid' ? 'paid' : 'bad_debt',
        issuedDate: c.startIso,
        dueDate: null,
        receivedDate: scenario === 'invoice_paid' ? c.iso : null,
        amounts: {
          total: dollars(c.amount),
          invoiceBalance: scenario === 'invoice_paid' ? 0 : dollars(c.amount),
          paymentsTotal: scenario === 'invoice_paid' ? dollars(c.amount) : 0,
        },
        client,
        jobs: { nodes: [{ id: job.id }] },
      };
      break;
  }
  const accountId = 'sandbox-jobber-account';
  const body = { data: { webHookEvent: { topic, appId: 'contractor-crm-bridge', accountId, itemId: node.id, occurredAt: c.iso } } };
  return { body, fixtures: [[`jobber:${kind}:${String(node.id)}`, node]] as Array<[string, unknown]> };
}

function housecallpro(scenario: Scenario, c: Ctx) {
  const customer = {
    id: `cus_${hex(c.personaKey, 'hcp-cus')}`,
    first_name: c.p.firstName,
    last_name: c.p.lastName,
    email: c.p.email,
    mobile_number: c.p.phone,
    home_number: null,
    work_number: null,
    company: null,
    notifications_enabled: true,
    lead_source: c.p.leadSource,
    tags: [],
    addresses: [{ id: `adr_${hex(c.personaKey, 'hcp-adr')}`, type: 'service', street: c.p.street, street_line_2: null, city: c.p.city, state: c.p.state, zip: c.p.zip, country: 'US' }],
    created_at: '2024-01-10T14:00:00Z',
  };
  const jobId = `job_${hex(c.ref, 'hcp-job')}`;
  const job = {
    id: jobId,
    invoice_number: String(10000 + (c.n % 90000)),
    description: c.job.title,
    customer,
    address: customer.addresses[0],
    work_status: 'scheduled',
    work_timestamps: { on_my_way_at: null as string | null, started_at: null as string | null, completed_at: null as string | null },
    schedule: { scheduled_start: c.startIso, scheduled_end: null, arrival_window: 60 },
    total_amount: c.amount,
    outstanding_balance: c.amount,
    assigned_employees: [{ id: `pro_${c.tech.id}`, first_name: c.tech.name.split(' ')[0], last_name: c.tech.name.split(' ')[1], role: 'field tech' }],
    tags: c.flags,
    lead_source: c.p.leadSource,
    ...(c.satisfaction ? { rating: c.satisfaction } : {}),
    created_at: c.startIso,
    updated_at: c.iso,
  };
  const base = { id: `evt_${hex(`${c.ref}:${scenario}:${c.iso}`, 'hcp-evt', 16)}`, company_id: 'sandbox-hcp-company', timestamp: c.iso };
  switch (scenario) {
    case 'customer_created':
      return { ...base, event: 'customer.created', customer };
    case 'estimate_approved':
      return {
        ...base,
        event: 'estimate.option.approval_status_changed',
        estimate: {
          id: `est_${hex(c.ref, 'hcp-est')}`,
          estimate_number: String(5000 + (c.n % 9000)),
          work_status: 'scheduled',
          customer,
          job_id: jobId,
          options: [
            { id: `opt_${hex(c.ref, 'a')}`, name: `${c.job.estimate} – Good`, total_amount: Math.round(c.estimateAmount * 0.7), approval_status: 'declined' },
            { id: `opt_${hex(c.ref, 'b')}`, name: `${c.job.estimate} – Best`, total_amount: c.estimateAmount, approval_status: 'approved', approved_at: c.iso },
          ],
          created_at: c.startIso,
          updated_at: c.iso,
        },
      };
    case 'technician_dispatched':
      return { ...base, event: 'job.on_my_way', job: { ...job, work_timestamps: { ...job.work_timestamps, on_my_way_at: c.iso } } };
    case 'job_completed':
    case 'job_callback':
      return {
        ...base,
        event: 'job.completed',
        job: { ...job, work_status: 'complete unrated', work_timestamps: { on_my_way_at: c.startIso, started_at: c.startIso, completed_at: c.iso } },
      };
    case 'invoice_paid':
      return {
        ...base,
        event: 'job.paid',
        job: { ...job, work_status: 'complete unrated', outstanding_balance: 0, work_timestamps: { on_my_way_at: c.startIso, started_at: c.startIso, completed_at: c.startIso } },
        invoice: { id: `inv_${hex(c.ref, 'hcp-inv')}`, invoice_number: job.invoice_number, amount: c.amount, paid_at: c.iso, job_id: jobId },
      };
    case 'invoice_disputed':
      return {
        ...base,
        event: 'invoice.updated',
        invoice: { id: `inv_${hex(c.ref, 'hcp-inv')}`, invoice_number: job.invoice_number, amount: c.amount, due_amount: c.amount, status: 'disputed', job_id: jobId, customer },
      };
  }
}

function servicetitan(scenario: Scenario, c: Ctx) {
  const customerId = 40000000 + (seed(c.personaKey) % 1000000);
  const jobId = 60000000 + (c.n % 1000000);
  const customer = {
    id: customerId,
    name: `${c.p.firstName} ${c.p.lastName}`,
    type: 'Residential',
    address: { street: c.p.street, unit: null, city: c.p.city, state: c.p.state, zip: c.p.zip, country: 'USA' },
    contacts: [
      { type: 'MobilePhone', value: c.p.phone, memo: 'cell' },
      { type: 'Email', value: c.p.email, memo: null },
    ],
    doNotMail: false,
    doNotService: false,
    campaign: { name: c.p.leadSource },
    createdOn: '2023-11-02T16:20:00Z',
  };
  const job = {
    id: jobId,
    jobNumber: String(jobId),
    customerId,
    customer,
    locationId: customerId + 1,
    location: { address: customer.address },
    jobStatus: 'Scheduled',
    summary: c.job.title,
    jobType: { name: c.job.title.split(' – ')[0] },
    total: dollars(c.amount),
    start: c.startIso,
    completedOn: null as string | null,
    technicians: [{ id: Number(c.tech.id), name: c.tech.name }],
    tagTypes: c.flags.map((name) => ({ name })),
    recallForId: scenario === 'job_callback' ? jobId - 17 : null,
    warrantyId: null,
    ...(c.satisfaction ? { customerSatisfactionScore: c.satisfaction } : {}),
  };
  const envelope = (eventType: string, data: unknown) => ({
    eventId: `st-${hex(`${c.ref}:${scenario}:${c.iso}`, 'st-evt', 20)}`,
    eventType,
    tenantId: '1234567',
    createdOn: c.iso,
    data,
  });
  switch (scenario) {
    case 'customer_created':
      return envelope('CustomerCreated', customer);
    case 'estimate_approved':
      return envelope('EstimateSold', {
        id: 80000000 + (c.n % 1000000),
        jobId,
        name: c.job.estimate,
        status: { value: 1, name: 'Sold' },
        subtotal: dollars(c.estimateAmount),
        tax: 0,
        soldOn: c.iso,
        customerId,
        customer,
        createdOn: c.startIso,
      });
    case 'technician_dispatched':
      return envelope('TechnicianDispatched', {
        appointmentId: jobId + 5,
        technicianId: Number(c.tech.id),
        technicianName: c.tech.name,
        dispatchedOn: c.iso,
        job: { ...job, jobStatus: 'Dispatched', technicians: undefined },
      });
    case 'job_completed':
    case 'job_callback':
      return envelope('JobCompleted', { ...job, jobStatus: 'Completed', completedOn: c.iso });
    case 'invoice_paid':
    case 'invoice_disputed':
      return envelope(scenario === 'invoice_paid' ? 'InvoicePaid' : 'InvoiceUpdated', {
        id: 90000000 + (c.n % 1000000),
        referenceNumber: String(jobId),
        invoiceDate: c.startIso,
        dueDate: null,
        subTotal: dollars(c.amount),
        salesTax: 0,
        total: dollars(c.amount).toFixed(2),
        balance: scenario === 'invoice_paid' ? '0.00' : dollars(c.amount).toFixed(2),
        status: scenario === 'invoice_paid' ? { name: 'Posted' } : { name: 'Disputed' },
        customer: { id: customerId, name: customer.name },
        job: { id: jobId, number: String(jobId) },
        paidOn: scenario === 'invoice_paid' ? c.iso : null,
      });
  }
}

function fieldedge(scenario: Scenario, c: Ctx) {
  const customerId = `C-${10000 + (seed(c.personaKey) % 90000)}`;
  const woId = `WO-${100000 + (c.n % 900000)}`;
  const customer = {
    CustomerId: customerId,
    FirstName: c.p.firstName,
    LastName: c.p.lastName,
    DisplayName: `${c.p.lastName}, ${c.p.firstName}`,
    Phones: [{ Number: c.p.phone, Type: 'Mobile' }],
    Email: c.p.email,
    BillingAddress: { Address1: c.p.street, City: c.p.city, State: c.p.state, Zip: c.p.zip },
    LeadSource: c.p.leadSource,
    CreatedDate: '/Date(1704067200000)/',
  };
  const wo = {
    WorkOrderId: woId,
    WorkOrderNumber: woId.replace('WO-', ''),
    Status: 'Scheduled',
    Description: c.job.title,
    Customer: customer,
    ServiceLocation: customer.BillingAddress,
    Technicians: [{ EmployeeId: c.tech.id, Name: c.tech.name }],
    ScheduledDate: c.startIso,
    CompletedDate: null as string | null,
    TotalAmount: dollars(c.amount),
    IsCallback: scenario === 'job_callback',
    Tags: c.flags,
    ...(c.satisfaction ? { SurveyRating: c.satisfaction } : {}),
  };
  const envelope = (EventType: string, Data: unknown) => ({
    EventId: `fe-${hex(`${c.ref}:${scenario}:${c.iso}`, 'fe-evt', 20)}`,
    EventType,
    CompanyId: 'sandbox-fieldedge',
    Timestamp: c.iso,
    Data,
  });
  switch (scenario) {
    case 'customer_created':
      return envelope('Customer.Created', customer);
    case 'estimate_approved':
      return envelope('Estimate.Accepted', {
        EstimateId: `E-${100000 + (c.n % 900000)}`,
        EstimateNumber: String(100000 + (c.n % 900000)),
        Description: c.job.estimate,
        Status: 'Accepted',
        Total: dollars(c.estimateAmount),
        AcceptedDate: c.iso,
        WorkOrderId: woId,
        Customer: customer,
      });
    case 'technician_dispatched':
      return envelope('WorkOrder.Dispatched', { ...wo, Status: 'Dispatched', DispatchedDate: c.iso });
    case 'job_completed':
    case 'job_callback':
      return envelope('WorkOrder.Completed', { ...wo, Status: 'Completed', CompletedDate: c.iso });
    case 'invoice_paid':
    case 'invoice_disputed':
      return envelope(scenario === 'invoice_paid' ? 'Invoice.Paid' : 'Invoice.Updated', {
        InvoiceId: `I-${100000 + (c.n % 900000)}`,
        InvoiceNumber: String(100000 + (c.n % 900000)),
        Status: scenario === 'invoice_paid' ? 'Paid' : 'Disputed',
        Total: dollars(c.amount),
        AmountPaid: scenario === 'invoice_paid' ? dollars(c.amount) : 0,
        BalanceDue: scenario === 'invoice_paid' ? 0 : dollars(c.amount),
        PaidDate: scenario === 'invoice_paid' ? c.iso : null,
        InvoiceDate: c.startIso,
        WorkOrderId: woId,
        Customer: customer,
      });
  }
}

function buildertrend(scenario: Scenario, c: Ctx) {
  const ownerId = 300000 + (seed(c.personaKey) % 100000);
  const jobId = 500000 + (c.n % 100000);
  const owner = {
    id: ownerId,
    first_name: c.p.firstName,
    last_name: c.p.lastName,
    email: c.p.email,
    cell_phone: c.p.phone,
    phone: null,
    street_address: c.p.street,
    city: c.p.city,
    state: c.p.state,
    zip: c.p.zip,
    lead_source: c.p.leadSource,
  };
  const job = {
    id: jobId,
    job_name: c.job.title,
    job_number: `BT-${jobId}`,
    status: 'open',
    owner,
    project_manager: { id: 9100, name: 'Rachel Kim' },
    street_address: c.p.street,
    city: c.p.city,
    state: c.p.state,
    zip: c.p.zip,
    contract_price: dollars(c.amount),
    projected_start: c.startIso,
    actual_start: c.startIso,
    actual_completion: null as string | null,
    tags: c.flags,
    ...(c.satisfaction ? { survey: { rating: c.satisfaction } } : {}),
  };
  const envelope = (event: string, data: unknown) => ({
    delivery_id: `bt-${hex(`${c.ref}:${scenario}:${c.iso}`, 'bt-evt', 20)}`,
    event,
    builder_id: 'sandbox-builder',
    timestamp: c.iso,
    data,
  });
  switch (scenario) {
    case 'customer_created':
      return envelope('owner.created', owner);
    case 'estimate_approved':
      return envelope('proposal.approved', {
        id: 700000 + (c.n % 100000),
        title: c.job.estimate,
        status: 'approved',
        owner_price: dollars(c.estimateAmount),
        approved_date: c.iso,
        job_id: jobId,
        owner,
      });
    case 'technician_dispatched':
      return envelope('schedule_item.assigned', {
        id: 800000 + (c.n % 100000),
        title: 'Demo & rough-in',
        start_date: c.iso,
        assignees: [{ id: Number(c.tech.id), name: c.tech.name }],
        job,
      });
    case 'job_completed':
    case 'job_callback':
      return envelope('job.closed', { ...job, status: 'closed', actual_completion: c.iso });
    case 'invoice_paid':
    case 'invoice_disputed':
      return envelope(scenario === 'invoice_paid' ? 'owner_invoice.paid' : 'owner_invoice.updated', {
        id: 900000 + (c.n % 100000),
        invoice_number: `INV-${jobId}`,
        title: 'Final payment',
        status: scenario === 'invoice_paid' ? 'paid' : 'disputed',
        amount: dollars(c.amount),
        amount_paid: scenario === 'invoice_paid' ? dollars(c.amount) : 0,
        paid_date: scenario === 'invoice_paid' ? c.iso : null,
        job_id: jobId,
        owner,
      });
  }
}

let counter = 0;

export function newJobRef(): string {
  counter += 1;
  return `sim-${Date.now().toString(36)}-${counter}`;
}

export function buildSimulatedWebhook(req: SimulationRequest, secret: string): SimulatedWebhook {
  const jobRef = req.jobRef ?? newJobRef();
  const n = seed(`${req.source}:${jobRef}`);
  const persona = typeof req.persona === 'object' ? req.persona : PERSONAS[(req.persona ?? n) % PERSONAS.length]!;
  const personaKey = `${persona.email}|${persona.phone}`;
  const trades = TRADES[req.source];
  const now = req.now ?? new Date();
  const ctx: Ctx = {
    ref: jobRef,
    n,
    p: persona,
    personaKey,
    job: trades[n % trades.length]!,
    now,
    iso: now.toISOString(),
    startIso: new Date(now.getTime() - 3 * 3600_000).toISOString(),
    amount: req.amountCents ?? 65_000,
    estimateAmount: req.amountCents ?? 125_000,
    flags: req.scenario === 'job_callback' ? ['Callback', 'Customer complaint'] : [],
    satisfaction: req.satisfaction ?? (req.scenario === 'job_callback' ? 2 : undefined),
    tech: TECHS[n % TECHS.length]!,
  };
  const { body, fixtures } = build(req.source, req.scenario, ctx);
  const rawBody = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    'user-agent': `${req.source}-webhooks/sandbox`,
    'x-bridge-simulated': 'true',
    ...signPayload(req.source, secret, rawBody, { timestamp: Math.floor(now.getTime() / 1000) }),
  };
  return { source: req.source, scenario: req.scenario, jobRef, body, rawBody, headers, fixtures };
}

/** Builds, signs and ingests a simulated webhook through the full production pipeline. */
export async function runSimulation(engine: BridgeEngine, req: SimulationRequest): Promise<{ webhook: SimulatedWebhook; delivery: DeliveryRecord }> {
  const secret = engine.connections[req.source]?.webhookSecret;
  if (!secret) throw new Error(`no webhook secret configured for ${req.source}; the sandbox signs webhooks with it`);
  const webhook = buildSimulatedWebhook(req, secret);
  for (const [key, node] of webhook.fixtures) engine.sandboxFixtures.set(key, node);
  const delivery = await engine.ingest(req.source, webhook.rawBody, webhook.headers, { simulated: true });
  return { webhook, delivery };
}

export async function runLifecycle(
  engine: BridgeEngine,
  req: Omit<SimulationRequest, 'scenario'>,
): Promise<Array<{ webhook: SimulatedWebhook; delivery: DeliveryRecord }>> {
  const jobRef = req.jobRef ?? newJobRef();
  const out = [];
  const base = req.now ?? new Date();
  for (const [i, scenario] of LIFECYCLE.entries()) {
    out.push(await runSimulation(engine, { ...req, jobRef, scenario, now: new Date(base.getTime() + i * 60_000) }));
  }
  return out;
}
