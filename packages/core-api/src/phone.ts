/**
 * Dependency-free E.164 normalization tuned for North American field-service data,
 * with a pragmatic fallback for explicitly international numbers.
 *
 * Rules:
 *  - Strips formatting, extensions (`x123`, `ext. 123`, `#123`) and `tel:` prefixes.
 *  - `+<digits>` is trusted as international if 8..15 digits and a valid NANP number when it starts with +1.
 *  - `00<digits>` / `011<digits>` international dialing prefixes are converted to `+`.
 *  - 10 digits → NANP with default country (+1). 11 digits starting with 1 → NANP.
 *  - NANP area code and exchange must start with 2-9 (N11 service codes rejected for area code).
 *  - Obvious junk (all same digit, 555-01xx fictional range kept valid, too short) → null.
 */

const EXTENSION_RE = /(?:\s*(?:ext\.?|extension|x|#)\s*\d{1,6})\s*$/i;

export interface PhoneOptions {
  /** Default country calling code when a national number is given. Only `1` (NANP) is supported for national parsing. */
  defaultCountryCode?: '1';
}

function isValidNanp(national10: string): boolean {
  if (!/^\d{10}$/.test(national10)) return false;
  const area = national10.slice(0, 3);
  const exchange = national10.slice(3, 6);
  if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) return false;
  // N11 codes (211, 311, ... 911) are service codes, never area codes.
  if (/^[2-9]11$/.test(area)) return false;
  if (/^(\d)\1{9}$/.test(national10)) return false;
  return true;
}

export function toE164(input: unknown, options: PhoneOptions = {}): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let raw = String(input).trim();
  if (!raw) return null;
  raw = raw.replace(/^tel:/i, '');
  raw = raw.replace(EXTENSION_RE, '');
  // Reject inputs containing letters after extension removal (vanity numbers are not supported).
  if (/[a-z]/i.test(raw)) return null;

  const hasPlus = raw.trimStart().startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (!hasPlus) {
    if (digits.startsWith('011')) {
      digits = digits.slice(3);
      return finalizeInternational(digits);
    }
    if (digits.startsWith('00')) {
      digits = digits.slice(2);
      return finalizeInternational(digits);
    }
    const cc = options.defaultCountryCode ?? '1';
    if (cc === '1') {
      if (digits.length === 10) return isValidNanp(digits) ? `+1${digits}` : null;
      if (digits.length === 11 && digits.startsWith('1')) {
        const national = digits.slice(1);
        return isValidNanp(national) ? `+${digits}` : null;
      }
    }
    return null;
  }
  return finalizeInternational(digits);
}

function finalizeInternational(digits: string): string | null {
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('0')) return null;
  if (digits.startsWith('1')) {
    if (digits.length !== 11) return null;
    return isValidNanp(digits.slice(1)) ? `+${digits}` : null;
  }
  if (/^(\d)\1+$/.test(digits)) return null;
  return `+${digits}`;
}

/** Collects unique E.164 numbers from a list of candidates, preserving order. */
export function collectPhones(candidates: unknown[], options?: PhoneOptions): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    const e164 = toE164(candidate, options);
    if (e164 && !out.includes(e164)) out.push(e164);
  }
  return out;
}

/** Formats an E.164 NANP number for humans: `+15125550142` → `(512) 555-0142`. */
export function formatNational(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase().replace(/^mailto:/, '');
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

export function collectEmails(candidates: unknown[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    const email = normalizeEmail(candidate);
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}
