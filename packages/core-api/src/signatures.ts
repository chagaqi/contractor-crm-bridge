import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FsmSource } from './types.js';

/**
 * Per-provider webhook signature schemes.
 *
 * - Jobber: `X-Jobber-Hmac-SHA256` = base64(HMAC-SHA256(clientSecret, rawBody)) — per Jobber developer docs.
 * - Housecall Pro: `Api-Signature` = hex(HMAC-SHA256(signingSecret, `${Api-Timestamp}.${rawBody}`)), with timestamp tolerance.
 * - ServiceTitan / FieldEdge / Buildertrend: partner-provisioned HMAC-SHA256 schemes. The header names and encodings
 *   below are the defaults this bridge ships with; each is overridable per connection via `SignatureScheme`
 *   so a partner sandbox can be matched without code changes.
 */
export interface SignatureScheme {
  header: string;
  encoding: 'hex' | 'base64';
  /** Optional prefix on the header value, e.g. `sha256=`. */
  prefix?: string;
  /** When set, the signed message is `${timestamp}.${body}` and the timestamp is read from this header. */
  timestampHeader?: string;
  /** Max allowed clock skew for timestamped schemes, in seconds. */
  toleranceSeconds?: number;
}

export const DEFAULT_SCHEMES: Record<FsmSource, SignatureScheme> = {
  jobber: { header: 'x-jobber-hmac-sha256', encoding: 'base64' },
  housecallpro: {
    header: 'api-signature',
    encoding: 'hex',
    timestampHeader: 'api-timestamp',
    toleranceSeconds: 300,
  },
  servicetitan: { header: 'x-servicetitan-signature', encoding: 'base64' },
  fieldedge: { header: 'x-fieldedge-signature', encoding: 'hex' },
  buildertrend: { header: 'x-buildertrend-signature', encoding: 'hex', prefix: 'sha256=' },
};

export type HeaderBag = Record<string, string | string[] | undefined>;

export function getHeader(headers: HeaderBag, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export interface SignatureResult {
  valid: boolean;
  reason?: string;
}

function hmac(secret: string, message: string, encoding: 'hex' | 'base64'): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest(encoding);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function signPayload(
  source: FsmSource,
  secret: string,
  rawBody: string,
  options: { scheme?: SignatureScheme; timestamp?: number } = {},
): Record<string, string> {
  const scheme = options.scheme ?? DEFAULT_SCHEMES[source];
  const headers: Record<string, string> = {};
  let message = rawBody;
  if (scheme.timestampHeader) {
    const ts = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    headers[scheme.timestampHeader] = ts;
    message = `${ts}.${rawBody}`;
  }
  headers[scheme.header] = `${scheme.prefix ?? ''}${hmac(secret, message, scheme.encoding)}`;
  return headers;
}

export function verifySignature(
  source: FsmSource,
  secret: string,
  rawBody: string,
  headers: HeaderBag,
  options: { scheme?: SignatureScheme; now?: number } = {},
): SignatureResult {
  const scheme = options.scheme ?? DEFAULT_SCHEMES[source];
  let provided = getHeader(headers, scheme.header);
  if (!provided) return { valid: false, reason: `missing ${scheme.header} header` };
  provided = provided.trim();
  if (scheme.prefix) {
    if (!provided.startsWith(scheme.prefix)) return { valid: false, reason: `signature missing ${scheme.prefix} prefix` };
    provided = provided.slice(scheme.prefix.length);
  }
  let message = rawBody;
  if (scheme.timestampHeader) {
    const ts = getHeader(headers, scheme.timestampHeader);
    if (!ts || !/^\d+$/.test(ts)) return { valid: false, reason: `missing ${scheme.timestampHeader} header` };
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const tolerance = scheme.toleranceSeconds ?? 300;
    if (Math.abs(now - Number(ts)) > tolerance) return { valid: false, reason: 'timestamp outside tolerance window' };
    message = `${ts}.${rawBody}`;
  }
  const expected = hmac(secret, message, scheme.encoding);
  if (!safeEqual(expected, provided)) return { valid: false, reason: 'signature mismatch' };
  return { valid: true };
}
