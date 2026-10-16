/**
 * Revenue attribution: a per-contact ledger of jobs, estimates and invoices from every FSM,
 * rolled up into lifetime value and lead-source attribution.
 */
import type { BridgeStore } from './store.js';
import type { CustomerMetrics, FsmSource, NormalizedEstimate, NormalizedInvoice, NormalizedJob } from './types.js';
import { nowIso } from './util.js';

export function entityKey(source: FsmSource, externalId: string): string {
  return `${source}:${externalId}`;
}

export class RevenueLedger {
  constructor(private readonly store: BridgeStore) {}

  recordJob(contactId: string, job: NormalizedJob): void {
    const key = entityKey(job.source, job.externalId);
    const prev = this.store.jobs.get(key)?.entity;
    // Never regress a completed job back to an earlier status because of out-of-order webhooks.
    const entity: NormalizedJob =
      prev && prev.status === 'completed' && job.status !== 'completed' && job.status !== 'cancelled'
        ? { ...job, status: 'completed', completedAt: prev.completedAt }
        : { ...job, completedAt: job.completedAt ?? prev?.completedAt ?? null };
    if (prev) {
      entity.flags = [...new Set([...prev.flags, ...job.flags])];
      entity.satisfactionScore = job.satisfactionScore ?? prev.satisfactionScore;
      if (!entity.technicians.length) entity.technicians = prev.technicians;
      if (!entity.totalCents) entity.totalCents = prev.totalCents;
    }
    this.store.jobs.set(key, { contactId, entity, updatedAt: nowIso() });
    this.store.touch();
  }

  recordEstimate(contactId: string, estimate: NormalizedEstimate): void {
    this.store.estimates.set(entityKey(estimate.source, estimate.externalId), { contactId, entity: estimate, updatedAt: nowIso() });
    this.store.touch();
  }

  recordInvoice(contactId: string, invoice: NormalizedInvoice): void {
    const key = entityKey(invoice.source, invoice.externalId);
    const prev = this.store.invoices.get(key)?.entity;
    const entity = { ...invoice, jobExternalId: invoice.jobExternalId ?? prev?.jobExternalId ?? null };
    this.store.invoices.set(key, { contactId, entity, updatedAt: nowIso() });
    this.store.touch();
  }

  getJob(source: FsmSource, externalId: string): NormalizedJob | undefined {
    return this.store.jobs.get(entityKey(source, externalId))?.entity;
  }

  invoicesForJob(source: FsmSource, jobExternalId: string): NormalizedInvoice[] {
    return [...this.store.invoices.values()]
      .map((e) => e.entity)
      .filter((i) => i.source === source && i.jobExternalId === jobExternalId);
  }

  invoicesForContact(contactId: string): NormalizedInvoice[] {
    return [...this.store.invoices.values()].filter((e) => e.contactId === contactId).map((e) => e.entity);
  }

  jobsForContact(contactId: string): NormalizedJob[] {
    return [...this.store.jobs.values()].filter((e) => e.contactId === contactId).map((e) => e.entity);
  }

  metrics(contactId: string): CustomerMetrics {
    const invoices = this.invoicesForContact(contactId);
    const jobs = this.jobsForContact(contactId);
    let ltv = 0;
    let invoiced = 0;
    let outstanding = 0;
    let paidCount = 0;
    for (const inv of invoices) {
      if (inv.status === 'void' || inv.status === 'draft') continue;
      if (inv.status === 'refunded') continue;
      invoiced += inv.totalCents;
      ltv += inv.amountPaidCents;
      if (inv.status === 'paid') paidCount += 1;
      else outstanding += inv.balanceCents;
    }
    const completed = jobs.filter((j) => j.status === 'completed');
    const completedDates = completed.map((j) => j.completedAt).filter((d): d is string => Boolean(d)).sort();
    return {
      lifetimeValueCents: ltv,
      totalInvoicedCents: invoiced,
      outstandingCents: outstanding,
      paidInvoiceCount: paidCount,
      completedJobCount: completed.length,
      averageTicketCents: paidCount ? Math.round(ltv / paidCount) : 0,
      firstJobAt: completedDates[0] ?? null,
      lastJobAt: completedDates[completedDates.length - 1] ?? null,
      lastReviewRequestAt: this.store.reviewRequests.get(contactId) ?? null,
    };
  }

  /** Revenue rolled up by lead source and by FSM. */
  attribution(): AttributionReport {
    const byLeadSource = new Map<string, AttributionRow>();
    const bySource = new Map<string, AttributionRow>();
    let total = 0;
    const row = (map: Map<string, AttributionRow>, key: string) => {
      let r = map.get(key);
      if (!r) {
        r = { key, contacts: 0, revenueCents: 0, paidInvoices: 0, completedJobs: 0, averageTicketCents: 0 };
        map.set(key, r);
      }
      return r;
    };
    const seenContacts = new Map<string, Set<string>>();
    const bump = (map: Map<string, AttributionRow>, key: string, contactId: string) => {
      const r = row(map, key);
      const set = seenContacts.get(`${map === byLeadSource ? 'l' : 's'}:${key}`) ?? new Set<string>();
      if (!set.has(contactId)) {
        set.add(contactId);
        r.contacts += 1;
      }
      seenContacts.set(`${map === byLeadSource ? 'l' : 's'}:${key}`, set);
      return r;
    };
    for (const { contactId, entity } of this.store.invoices.values()) {
      if (entity.status === 'void' || entity.status === 'refunded' || entity.status === 'draft') continue;
      const contact = this.store.contacts.get(contactId);
      const lead = contact?.leadSource ?? 'unattributed';
      for (const [map, key] of [
        [byLeadSource, lead],
        [bySource, entity.source],
      ] as const) {
        const r = bump(map, key, contactId);
        r.revenueCents += entity.amountPaidCents;
        if (entity.status === 'paid') r.paidInvoices += 1;
      }
      total += entity.amountPaidCents;
    }
    for (const { contactId, entity } of this.store.jobs.values()) {
      if (entity.status !== 'completed') continue;
      const contact = this.store.contacts.get(contactId);
      bump(byLeadSource, contact?.leadSource ?? 'unattributed', contactId).completedJobs += 1;
      bump(bySource, entity.source, contactId).completedJobs += 1;
    }
    const finish = (map: Map<string, AttributionRow>) =>
      [...map.values()]
        .map((r) => ({ ...r, averageTicketCents: r.paidInvoices ? Math.round(r.revenueCents / r.paidInvoices) : 0 }))
        .sort((a, b) => b.revenueCents - a.revenueCents);
    return { totalRevenueCents: total, byLeadSource: finish(byLeadSource), bySource: finish(bySource) };
  }
}

export interface AttributionRow {
  key: string;
  contacts: number;
  revenueCents: number;
  paidInvoices: number;
  completedJobs: number;
  averageTicketCents: number;
}

export interface AttributionReport {
  totalRevenueCents: number;
  byLeadSource: AttributionRow[];
  bySource: AttributionRow[];
}
