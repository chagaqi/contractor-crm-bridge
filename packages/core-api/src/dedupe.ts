/**
 * Contact identity resolution — strict, deterministic, explainable.
 *
 * Match keys (precedence order):
 *   1. External id     `ext:<source>:<externalId>`  (same record in the same FSM — always the same person)
 *   2. E.164 phone     `phone:+15125550142`         (any phone on the record)
 *   3. Email           `email:jane@example.com`     (lower-cased)
 *
 * We never match on names or addresses. A phone/email hit is *rejected* (a new contact is created)
 * when it would merge two different records from the same FSM whose other identifier conflicts —
 * e.g. spouses sharing a household landline but with different emails, each a separate Jobber client.
 */
import type { BridgeStore } from './store.js';
import type { NormalizedCustomer, UnifiedContact } from './types.js';
import { newId, nowIso } from './util.js';

export type MatchKind = 'external_id' | 'phone' | 'email' | 'created';

export interface ResolveResult {
  contact: UnifiedContact;
  matchedBy: MatchKind;
  created: boolean;
  /** Fields that changed on an existing contact. */
  changed: string[];
  /** Non-fatal notes, e.g. rejected household merges. */
  notes: string[];
}

export function externalKey(source: string, externalId: string): string {
  return `ext:${source}:${externalId}`;
}

export function identityKeys(customer: NormalizedCustomer): string[] {
  return [
    externalKey(customer.source, customer.externalId),
    ...customer.phones.map((p) => `phone:${p}`),
    ...customer.emails.map((e) => `email:${e}`),
  ];
}

function conflictsWithinSource(contact: UnifiedContact, customer: NormalizedCustomer): boolean {
  const sameSourceOtherRecord = contact.externalIds.some(
    (k) => k.startsWith(`ext:${customer.source}:`) && k !== externalKey(customer.source, customer.externalId),
  );
  if (!sameSourceOtherRecord) return false;
  const emailConflict = customer.emails.length > 0 && contact.emails.length > 0 && !customer.emails.some((e) => contact.emails.includes(e));
  const phoneConflict = customer.phones.length > 0 && contact.phones.length > 0 && !customer.phones.some((p) => contact.phones.includes(p));
  return emailConflict || phoneConflict;
}

export class ContactResolver {
  constructor(private readonly store: BridgeStore) {}

  findByKey(key: string): UnifiedContact | undefined {
    const id = this.store.keyIndex.get(key);
    return id ? this.store.contacts.get(id) : undefined;
  }

  findByExternal(source: string, externalId: string): UnifiedContact | undefined {
    return this.findByKey(externalKey(source, externalId));
  }

  resolve(customer: NormalizedCustomer): ResolveResult {
    const notes: string[] = [];
    let contact = this.findByExternal(customer.source, customer.externalId);
    let matchedBy: MatchKind = 'external_id';

    if (!contact) {
      const candidates: Array<[MatchKind, string]> = [
        ...customer.phones.map((p): [MatchKind, string] => ['phone', `phone:${p}`]),
        ...customer.emails.map((e): [MatchKind, string] => ['email', `email:${e}`]),
      ];
      for (const [kind, key] of candidates) {
        const hit = this.findByKey(key);
        if (!hit) continue;
        if (conflictsWithinSource(hit, customer)) {
          notes.push(`rejected ${kind} match with ${hit.id}: different ${customer.source} record with conflicting identifiers (household)`);
          continue;
        }
        contact = hit;
        matchedBy = kind;
        break;
      }
    }

    if (!contact) {
      const now = nowIso();
      const created: UnifiedContact = {
        id: newId('ct'),
        firstName: customer.firstName,
        lastName: customer.lastName,
        displayName: customer.displayName,
        companyName: customer.companyName,
        phone: customer.phone,
        phones: [...customer.phones],
        email: customer.email,
        emails: [...customer.emails],
        address: customer.address,
        leadSource: customer.leadSource,
        tags: [...customer.tags],
        doNotContact: customer.doNotContact,
        externalIds: [externalKey(customer.source, customer.externalId)],
        createdAt: customer.createdAt ?? now,
        updatedAt: now,
      };
      this.store.contacts.set(created.id, created);
      this.index(created, customer, notes);
      this.store.touch();
      return { contact: created, matchedBy: 'created', created: true, changed: [], notes };
    }

    const changed = this.merge(contact, customer);
    this.index(contact, customer, notes);
    if (changed.length) contact.updatedAt = nowIso();
    this.store.touch();
    return { contact, matchedBy, created: false, changed, notes };
  }

  /** Merge policy: incoming non-null scalars win (FSM is the source of truth), lists are unioned. */
  private merge(contact: UnifiedContact, c: NormalizedCustomer): string[] {
    const changed: string[] = [];
    const scalar = <K extends 'firstName' | 'lastName' | 'companyName' | 'leadSource'>(key: K) => {
      const next = c[key];
      if (next !== null && next !== contact[key]) {
        contact[key] = next;
        changed.push(key);
      }
    };
    scalar('firstName');
    scalar('lastName');
    scalar('companyName');
    if (!contact.leadSource) scalar('leadSource');
    if (c.displayName && c.displayName !== contact.displayName && (c.firstName || c.lastName || c.companyName)) {
      contact.displayName = c.displayName;
      changed.push('displayName');
    }
    if (c.address && JSON.stringify(c.address) !== JSON.stringify(contact.address)) {
      contact.address = c.address;
      changed.push('address');
    }
    for (const p of c.phones) {
      if (!contact.phones.includes(p)) {
        contact.phones.push(p);
        if (!changed.includes('phones')) changed.push('phones');
      }
    }
    for (const e of c.emails) {
      if (!contact.emails.includes(e)) {
        contact.emails.push(e);
        if (!changed.includes('emails')) changed.push('emails');
      }
    }
    if (!contact.phone && c.phone) {
      contact.phone = c.phone;
      changed.push('phone');
    }
    if (!contact.email && c.email) {
      contact.email = c.email;
      changed.push('email');
    }
    for (const t of c.tags) {
      if (!contact.tags.includes(t)) {
        contact.tags.push(t);
        if (!changed.includes('tags')) changed.push('tags');
      }
    }
    if (c.doNotContact && !contact.doNotContact) {
      contact.doNotContact = true;
      changed.push('doNotContact');
    }
    const ext = externalKey(c.source, c.externalId);
    if (!contact.externalIds.includes(ext)) {
      contact.externalIds.push(ext);
      changed.push('externalIds');
    }
    return changed;
  }

  private index(contact: UnifiedContact, customer: NormalizedCustomer, notes: string[]): void {
    for (const key of identityKeys(customer)) {
      const owner = this.store.keyIndex.get(key);
      if (owner && owner !== contact.id) {
        // Shared phone/email (household) — keep the first owner; the external id is always re-pointed.
        if (key.startsWith('ext:')) this.store.keyIndex.set(key, contact.id);
        else notes.push(`${key} already belongs to ${owner}; not re-indexed`);
        continue;
      }
      this.store.keyIndex.set(key, contact.id);
    }
  }
}
