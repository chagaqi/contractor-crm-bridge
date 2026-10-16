import { createHash, randomUUID } from 'node:crypto';
import type { NormalizedAddress } from './types.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type AnyRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): AnyRecord {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.nodes)) return value.nodes as unknown[];
  if (isRecord(value) && Array.isArray(value.edges)) {
    return (value.edges as unknown[]).map((edge) => asRecord(edge).node);
  }
  return [];
}

/** Reads the first present (non-null, non-empty-string) value among dotted paths. */
export function pick(obj: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path.split('.')) {
      if (Array.isArray(cur) && /^\d+$/.test(part)) {
        cur = cur[Number(part)];
        continue;
      }
      if (!isRecord(cur)) {
        cur = undefined;
        break;
      }
      cur = cur[part];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

export function str(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return null;
}

export function pickStr(obj: unknown, ...paths: string[]): string | null {
  return str(pick(obj, ...paths));
}

/** Parses a dollar amount (number or string like "$1,234.50") into integer cents. */
export function dollarsToCents(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : 0;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '');
    const negative = /^\(.*\)$/.test(cleaned);
    const n = Number(cleaned.replace(/[()]/g, ''));
    if (!Number.isFinite(n)) return 0;
    return Math.round((negative ? -n : n) * 100);
  }
  if (isRecord(value)) {
    // Money objects: { amount: "12.30", currency } or { cents: 1230 }
    if (typeof value.cents === 'number') return Math.round(value.cents);
    return dollarsToCents(value.amount ?? value.value);
  }
  return 0;
}

/** Integer cents passthrough for providers that already send cents (Housecall Pro). */
export function centsValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.round(Number(value));
  return 0;
}

export function toIso(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    // Accept unix seconds or milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return toIso(Number(trimmed));
    // Microsoft JSON date: /Date(1700000000000)/
    const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(trimmed);
    if (ms) return toIso(Number(ms[1]));
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function stableId(prefix: string, ...parts: Array<string | number | null | undefined>): string {
  return `${prefix}_${sha256Hex(parts.map((p) => String(p ?? '')).join('|')).slice(0, 24)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function splitName(full: string | null): { firstName: string | null; lastName: string | null } {
  if (!full) return { firstName: null, lastName: null };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] ?? null, lastName: null };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] ?? null };
}

export function buildAddress(fields: {
  street?: unknown;
  street2?: unknown;
  city?: unknown;
  region?: unknown;
  postalCode?: unknown;
  country?: unknown;
}): NormalizedAddress | null {
  const street = [str(fields.street), str(fields.street2)].filter(Boolean).join(', ') || null;
  const address: NormalizedAddress = {
    street,
    city: str(fields.city),
    region: str(fields.region),
    postalCode: str(fields.postalCode),
    country: str(fields.country),
  };
  return Object.values(address).some((v) => v !== null) ? address : null;
}

export function lowerList(values: unknown): string[] {
  const out: string[] = [];
  for (const v of asArray(values)) {
    const s = str(isRecord(v) ? (v.name ?? v.label ?? v.value) : v);
    if (s && !out.includes(s.toLowerCase())) out.push(s.toLowerCase());
  }
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}
