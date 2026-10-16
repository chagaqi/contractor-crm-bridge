import { describe, expect, it } from 'vitest';
import {
  BridgeStore,
  buildSimulatedWebhook,
  CrmHttpError,
  FSM_SOURCES,
  LIFECYCLE,
  runLifecycle,
  runSimulation,
  SCENARIOS,
  signPayload,
  type CrmAdapter,
  type NormalizedEvent,
  type Scenario,
} from '../src/index.js';
import { makeEngine, SECRET } from './helpers.js';

const EXPECTED_EVENT: Record<Scenario, string> = {
  customer_created: 'customer.created',
  estimate_approved: 'estimate.approved',
  technician_dispatched: 'job.dispatched',
  job_completed: 'job.completed',
  invoice_paid: 'invoice.paid',
  job_callback: 'job.completed',
  invoice_disputed: 'invoice.disputed',
};

describe('FSM Sandbox Simulator × every FSM schema', () => {
  const matrix = FSM_SOURCES.flatMap((source) => SCENARIOS.map((scenario) => [source, scenario] as const));
  it.each(matrix)('%s / %s → signed, verified, normalized to the expected unified event', async (source, scenario) => {
    const { engine } = makeEngine();
    const { delivery } = await runSimulation(engine, { source, scenario, persona: 0 });
    expect(delivery.signature).toBe('valid');
    expect(delivery.status).toBe('processed');
    expect(delivery.events.map((e) => e.type)).toEqual([EXPECTED_EVENT[scenario]]);
    expect(delivery.contactId).toBeTruthy();
    const contact = engine.store.contacts.get(delivery.contactId!)!;
    if (source === 'servicetitan' && scenario.startsWith('invoice')) {
      // ServiceTitan invoices reference the customer by { id, name } only; identity comes from the external id.
      expect(contact.externalIds[0]).toMatch(/^ext:servicetitan:/);
      expect(contact.displayName).toBe('Maria Gonzalez');
    } else {
      expect(contact.phone).toBe('+15125550142');
      expect(contact.email).toBe('maria.gonzalez@example.com');
    }
  });
});

describe('BridgeEngine pipeline', () => {
  it('full lifecycle on every FSM fires each CRM trigger exactly once and one review request', async () => {
    for (const source of FSM_SOURCES) {
      const { engine, recorder } = makeEngine();
      const results = await runLifecycle(engine, { source, persona: 1, amountCents: 65_000 });
      expect(results.map((r) => r.delivery.status)).toEqual(LIFECYCLE.map(() => 'processed'));
      expect(recorder.triggers.map((t) => t.key)).toEqual([
        'estimate_approved',
        'technician_dispatched',
        'job_completed',
        'invoice_paid',
        'invoice_paid_high_value',
        'review_request_ready',
      ]);
      const review = recorder.triggers.find((t) => t.key === 'review_request_ready')!;
      expect(review.review).toMatchObject({ eligible: true, channels: ['sms', 'email'] });
      expect(review.fields).toMatchObject({ contact_phone: '+15125550187', fsm_source: source, lifetime_value: 650, review_eligible: true });
      expect(review.metrics.lifetimeValueCents).toBe(65_000);
    }
  });

  it('invoice below the high-value threshold fires invoice_paid only', async () => {
    const { engine, recorder } = makeEngine();
    await runSimulation(engine, { source: 'housecallpro', scenario: 'invoice_paid', amountCents: 49_999 });
    expect(recorder.triggers.map((t) => t.key)).toEqual(['invoice_paid']);
    await runSimulation(engine, { source: 'housecallpro', scenario: 'invoice_paid', amountCents: 50_000 });
    expect(recorder.triggers.map((t) => t.key)).toContain('invoice_paid_high_value');
  });

  it('callback / unhappy jobs never trigger a review request even after payment', async () => {
    const { engine, recorder } = makeEngine();
    await runSimulation(engine, { source: 'servicetitan', scenario: 'job_callback', jobRef: 'cb-1' });
    const { delivery } = await runSimulation(engine, { source: 'servicetitan', scenario: 'invoice_paid', jobRef: 'cb-1' });
    expect(recorder.triggers.map((t) => t.key)).not.toContain('review_request_ready');
    expect(delivery.steps.find((s) => s.step === 'review-gate')?.detail).toMatch(/recall|callback|satisfaction/);
  });

  it('out-of-order delivery (paid before completed) still requests the review on completion', async () => {
    const { engine, recorder } = makeEngine();
    await runSimulation(engine, { source: 'fieldedge', scenario: 'invoice_paid', jobRef: 'ooo' });
    expect(recorder.triggers.map((t) => t.key)).not.toContain('review_request_ready');
    await runSimulation(engine, { source: 'fieldedge', scenario: 'job_completed', jobRef: 'ooo' });
    expect(recorder.triggers.filter((t) => t.key === 'review_request_ready')).toHaveLength(1);
  });

  it('dedupes one customer across all five FSMs into a single unified contact with summed LTV', async () => {
    const { engine } = makeEngine();
    for (const source of FSM_SOURCES) await runLifecycle(engine, { source, persona: 0 });
    expect(engine.store.contacts.size).toBe(1);
    const [contact] = engine.listContacts();
    expect(contact!.externalIds).toHaveLength(5);
    expect(contact!.metrics.lifetimeValueCents).toBe(5 * 65_000);
    expect(contact!.metrics.completedJobCount).toBe(5);
  });

  it('rejects bad signatures and unsigned webhooks, and logs why', async () => {
    const { engine, recorder } = makeEngine();
    const hook = buildSimulatedWebhook({ source: 'jobber', scenario: 'job_completed' }, 'wrong-secret');
    const bad = await engine.ingest('jobber', hook.rawBody, hook.headers);
    expect(bad).toMatchObject({ status: 'rejected', signature: 'invalid', error: 'invalid signature: signature mismatch' });
    const { engine: open } = makeEngine({ connections: {} });
    expect((await open.ingest('jobber', hook.rawBody, {})).error).toBe('no webhook secret configured for jobber');
    expect(recorder.triggers).toHaveLength(0);
    expect(engine.store.deliveries[0]!.request.headers['x-jobber-hmac-sha256']).toMatch(/\[redacted\]$/);
  });

  it('rejects non-JSON bodies', async () => {
    const { engine } = makeEngine();
    const raw = 'not json';
    const rec = await engine.ingest('housecallpro', raw, signPayload('housecallpro', SECRET, raw));
    expect(rec).toMatchObject({ status: 'rejected', error: 'body is not valid JSON' });
  });

  it('is idempotent on provider delivery ids', async () => {
    const { engine, recorder } = makeEngine();
    const hook = buildSimulatedWebhook({ source: 'housecallpro', scenario: 'job_completed' }, SECRET);
    expect((await engine.ingest('housecallpro', hook.rawBody, hook.headers)).status).toBe('processed');
    expect((await engine.ingest('housecallpro', hook.rawBody, hook.headers)).status).toBe('duplicate');
    expect(recorder.triggers.filter((t) => t.key === 'job_completed')).toHaveLength(1);
  });

  it('marks unmapped provider events as ignored', async () => {
    const { engine } = makeEngine();
    const raw = JSON.stringify({ event: 'pro.updated', company_id: 'x' });
    expect((await engine.ingest('housecallpro', raw, signPayload('housecallpro', SECRET, raw))).status).toBe('ignored');
  });

  it('fails cleanly when a thin Jobber webhook cannot be hydrated', async () => {
    const { engine } = makeEngine();
    const hook = buildSimulatedWebhook({ source: 'jobber', scenario: 'job_completed' }, SECRET); // fixtures NOT registered
    const rec = await engine.ingest('jobber', hook.rawBody, hook.headers);
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/cannot hydrate jobber job/);
  });

  it('uses a configured hydrator for Jobber', async () => {
    const hook = buildSimulatedWebhook({ source: 'jobber', scenario: 'job_completed' }, SECRET);
    const node = hook.fixtures[0]![1];
    const { engine } = makeEngine({ hydrators: { jobber: async () => node } });
    expect((await engine.ingest('jobber', hook.rawBody, hook.headers)).status).toBe('processed');
  });

  it('retries transient CRM failures and records attempts', async () => {
    const { engine, recorder } = makeEngine({ retry: { attempts: 3, baseDelayMs: 0 } });
    recorder.failNext = 2;
    const { delivery } = await runSimulation(engine, { source: 'buildertrend', scenario: 'customer_created' });
    expect(delivery.status).toBe('processed');
    expect(delivery.crm[0]).toMatchObject({ action: 'contact.upsert', ok: true, attempts: 3 });
  });

  it('partial failure → logged, replayable, and replay skips triggers that already landed', async () => {
    const flaky: CrmAdapter & { calls: string[]; down: boolean } = {
      id: 'flaky',
      label: 'Flaky CRM',
      calls: [],
      down: true,
      isConnected: () => true,
      async syncContact() {
        return { ok: true, action: 'contact.upsert' };
      },
      async deliverTrigger(t) {
        this.calls.push(t.key);
        if (this.down) throw new CrmHttpError('bad credentials', 401, null);
        return { ok: true, action: `trigger.${t.key}` };
      },
    };
    const { engine, recorder } = makeEngine({ adapters: [] });
    engine.addAdapter(recorder);
    engine.addAdapter(flaky);
    const { delivery } = await runSimulation(engine, { source: 'servicetitan', scenario: 'estimate_approved' });
    expect(delivery.status).toBe('partial');
    expect(delivery.crm.find((c) => c.target === 'flaky' && c.action.startsWith('trigger.'))).toMatchObject({ ok: false, status: 401, attempts: 1 });
    expect(delivery.error).toMatch(/flaky\/trigger.estimate_approved: .*HTTP|bad credentials/);

    flaky.down = false;
    const replay = await engine.replay(delivery.id);
    expect(replay).toMatchObject({ status: 'processed', replayOf: delivery.id, signature: 'skipped' });
    expect(replay.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'estimate_approved', fired: false, reason: 'already delivered to recorder' }),
        expect.objectContaining({ key: 'estimate_approved', fired: true }),
      ]),
    );
    expect(recorder.triggers.filter((t) => t.key === 'estimate_approved')).toHaveLength(1);
  });

  it('refuses to replay a delivery that failed signature verification', async () => {
    const { engine } = makeEngine();
    const hook = buildSimulatedWebhook({ source: 'fieldedge', scenario: 'job_completed' }, 'nope');
    const rec = await engine.ingest('fieldedge', hook.rawBody, hook.headers);
    await expect(engine.replay(rec.id)).rejects.toThrow(/signature/);
  });

  it('does not consume the review cooldown when no CRM accepted the review trigger', async () => {
    const { engine } = makeEngine({ adapters: [] });
    await runLifecycle(engine, { source: 'jobber', jobRef: 'nocrm' });
    expect(engine.store.reviewRequests.size).toBe(0);
  });

  it('emits delivery records to listeners and persists to a JSON file', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'ccb-')), 'state.json');
    const store = new BridgeStore({ filePath: file });
    const { engine } = makeEngine({ store });
    const seen: string[] = [];
    engine.onDelivery((d) => seen.push(d.id));
    const { delivery } = await runSimulation(engine, { source: 'jobber', scenario: 'customer_created' });
    expect(seen).toEqual([delivery.id]);
    store.flush();
    const restored = new BridgeStore({ filePath: file });
    expect(restored.contacts.size).toBe(1);
    expect(restored.getDelivery(delivery.id)?.status).toBe('processed');
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });

  it('trigger field maps are flat and primitive-only (workflow-builder friendly)', async () => {
    const { engine, recorder } = makeEngine();
    await runLifecycle(engine, { source: 'housecallpro' });
    for (const t of recorder.triggers) {
      for (const v of Object.values(t.fields)) expect(v === null || ['string', 'number', 'boolean'].includes(typeof v)).toBe(true);
      expect((t.event as NormalizedEvent).id).toMatch(/^evt_/);
    }
  });
});
