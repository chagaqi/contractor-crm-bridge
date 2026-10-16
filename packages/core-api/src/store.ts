import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeliveryRecord } from './delivery-log.js';
import type { NormalizedEstimate, NormalizedInvoice, NormalizedJob, UnifiedContact } from './types.js';

export interface LedgerEntry<T> {
  contactId: string;
  entity: T;
  updatedAt: string;
}

export interface StoreSnapshot {
  version: 1;
  contacts: UnifiedContact[];
  keyIndex: Array<[string, string]>;
  jobs: Array<[string, LedgerEntry<NormalizedJob>]>;
  estimates: Array<[string, LedgerEntry<NormalizedEstimate>]>;
  invoices: Array<[string, LedgerEntry<NormalizedInvoice>]>;
  reviewRequests: Array<[string, string]>;
  reviewedJobs: string[];
  firedTriggers: string[];
  processedDeliveries: Array<[string, string]>;
  deliveries: DeliveryRecord[];
  kv: Array<[string, unknown]>;
}

/**
 * In-memory state with optional JSON-file persistence (atomic write via rename).
 * Everything the engine needs lives here so a production deployment can swap this
 * class for a Postgres/Redis-backed implementation with the same surface.
 */
export class BridgeStore {
  contacts = new Map<string, UnifiedContact>();
  /** `ext:<source>:<id>` | `phone:<e164>` | `email:<addr>` → contactId */
  keyIndex = new Map<string, string>();
  jobs = new Map<string, LedgerEntry<NormalizedJob>>();
  estimates = new Map<string, LedgerEntry<NormalizedEstimate>>();
  invoices = new Map<string, LedgerEntry<NormalizedInvoice>>();
  /** contactId → ISO timestamp of the last review request. */
  reviewRequests = new Map<string, string>();
  /** `${source}:${jobId}` that already triggered a review request. */
  reviewedJobs = new Set<string>();
  firedTriggers = new Set<string>();
  /** delivery idempotency key → delivery record id */
  processedDeliveries = new Map<string, string>();
  deliveries: DeliveryRecord[] = [];
  /** Generic key/value storage for shells (OAuth tokens, subscriptions, settings). */
  kv = new Map<string, unknown>();

  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly options: { maxDeliveries?: number; filePath?: string | null } = {},
  ) {
    if (options.filePath && existsSync(options.filePath)) {
      this.restore(JSON.parse(readFileSync(options.filePath, 'utf8')) as StoreSnapshot);
    }
  }

  get maxDeliveries(): number {
    return this.options.maxDeliveries ?? 2000;
  }

  addDelivery(record: DeliveryRecord): void {
    this.deliveries.unshift(record);
    if (this.deliveries.length > this.maxDeliveries) this.deliveries.length = this.maxDeliveries;
    this.touch();
  }

  getDelivery(id: string): DeliveryRecord | undefined {
    return this.deliveries.find((d) => d.id === id);
  }

  kvGet<T>(key: string): T | undefined {
    return this.kv.get(key) as T | undefined;
  }

  kvSet(key: string, value: unknown): void {
    this.kv.set(key, value);
    this.touch();
  }

  kvDelete(key: string): void {
    this.kv.delete(key);
    this.touch();
  }

  kvEntries<T>(prefix: string): Array<[string, T]> {
    return [...this.kv.entries()].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>;
  }

  snapshot(): StoreSnapshot {
    return {
      version: 1,
      contacts: [...this.contacts.values()],
      keyIndex: [...this.keyIndex.entries()],
      jobs: [...this.jobs.entries()],
      estimates: [...this.estimates.entries()],
      invoices: [...this.invoices.entries()],
      reviewRequests: [...this.reviewRequests.entries()],
      reviewedJobs: [...this.reviewedJobs],
      firedTriggers: [...this.firedTriggers],
      processedDeliveries: [...this.processedDeliveries.entries()],
      deliveries: this.deliveries,
      kv: [...this.kv.entries()],
    };
  }

  restore(s: StoreSnapshot): void {
    this.contacts = new Map(s.contacts.map((c) => [c.id, c]));
    this.keyIndex = new Map(s.keyIndex);
    this.jobs = new Map(s.jobs);
    this.estimates = new Map(s.estimates);
    this.invoices = new Map(s.invoices);
    this.reviewRequests = new Map(s.reviewRequests);
    this.reviewedJobs = new Set(s.reviewedJobs);
    this.firedTriggers = new Set(s.firedTriggers);
    this.processedDeliveries = new Map(s.processedDeliveries);
    this.deliveries = s.deliveries ?? [];
    this.kv = new Map(s.kv ?? []);
  }

  reset(): void {
    this.restore({
      version: 1,
      contacts: [],
      keyIndex: [],
      jobs: [],
      estimates: [],
      invoices: [],
      reviewRequests: [],
      reviewedJobs: [],
      firedTriggers: [],
      processedDeliveries: [],
      deliveries: [],
      kv: [...this.kv.entries()],
    });
    this.touch();
  }

  /** Marks the store dirty; persists (debounced) when a file path is configured. */
  touch(): void {
    const filePath = this.options.filePath;
    if (!filePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, 250);
    this.persistTimer.unref?.();
  }

  flush(): void {
    const filePath = this.options.filePath;
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.snapshot()));
    renameSync(tmp, filePath);
  }
}
