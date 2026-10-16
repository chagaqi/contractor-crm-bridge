/**
 * Shared auth primitives for the marketplace shells: OAuth token vault with refresh,
 * CSRF-safe OAuth `state`, HS256 JWTs (monday, session tokens) and CryptoJS-compatible
 * AES decryption (GoHighLevel Custom Page SSO).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BridgeStore } from './store.js';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scope?: string;
  /** Provider-specific identifiers (locationId, portalId, apiDomain ...). */
  meta?: Record<string, string>;
}

export class TokenVault {
  constructor(
    private readonly store: BridgeStore,
    private readonly namespace: string,
    private readonly now: () => number = Date.now,
  ) {}

  private key(account: string) {
    return `oauth:${this.namespace}:${account}`;
  }

  get(account: string): OAuthTokens | undefined {
    return this.store.kvGet<OAuthTokens>(this.key(account));
  }

  set(account: string, tokens: OAuthTokens): void {
    this.store.kvSet(this.key(account), tokens);
  }

  delete(account: string): void {
    this.store.kvDelete(this.key(account));
  }

  accounts(): string[] {
    const prefix = `oauth:${this.namespace}:`;
    return this.store.kvEntries<OAuthTokens>(prefix).map(([k]) => k.slice(prefix.length));
  }

  /** Returns a non-expired access token, refreshing (and persisting) it when within 60s of expiry. */
  async fresh(account: string, refresh: (tokens: OAuthTokens) => Promise<OAuthTokens>): Promise<OAuthTokens | undefined> {
    const tokens = this.get(account);
    if (!tokens) return undefined;
    if (tokens.expiresAt && tokens.expiresAt - 60_000 <= this.now()) {
      if (!tokens.refreshToken) return undefined;
      const next = await refresh(tokens);
      const merged = { ...tokens, ...next, meta: { ...(tokens.meta ?? {}), ...(next.meta ?? {}) } };
      this.set(account, merged);
      return merged;
    }
    return tokens;
  }
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** `state` = base64url(json).hmac — binds the OAuth round-trip to this server and expires after 10 minutes. */
export function signState(secret: string, data: Record<string, unknown> = {}, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ ...data, n: randomBytes(8).toString('hex'), t: now }));
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyState(secret: string, state: string | null | undefined, maxAgeMs = 600_000, now = Date.now()): Record<string, unknown> | null {
  if (!state) return null;
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof data.t !== 'number' || now - data.t > maxAgeMs) return null;
    return data;
  } catch {
    return null;
  }
}

export function signJwt(payload: Record<string, unknown>, secret: string, options: { expiresInSeconds?: number; now?: number } = {}): string {
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const body: Record<string, unknown> = { iat, ...payload };
  if (options.expiresInSeconds) body.exp = iat + options.expiresInSeconds;
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify(body));
  const sig = createHmac('sha256', secret).update(`${head}.${pay}`).digest('base64url');
  return `${head}.${pay}.${sig}`;
}

export function verifyJwt(token: string | null | undefined, secret: string, now = Date.now()): Record<string, unknown> | null {
  if (!token) return null;
  const raw = token.startsWith('Bearer ') ? token.slice(7) : token;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [head, pay, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${head}.${pay}`).digest('base64url');
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
    const payload = JSON.parse(Buffer.from(pay, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** OpenSSL EVP_BytesToKey (MD5, 1 iteration) — the KDF CryptoJS uses for passphrase-based AES. */
function evpBytesToKey(passphrase: Buffer, salt: Buffer, keyLen: number, ivLen: number): { key: Buffer; iv: Buffer } {
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let total = 0;
  while (total < keyLen + ivLen) {
    prev = createHash('md5').update(Buffer.concat([prev, passphrase, salt])).digest();
    out.push(prev);
    total += prev.length;
  }
  const all = Buffer.concat(out);
  return { key: all.subarray(0, keyLen), iv: all.subarray(keyLen, keyLen + ivLen) };
}

/** Equivalent of `CryptoJS.AES.encrypt(plaintext, passphrase).toString()`. */
export function cryptoJsAesEncrypt(plaintext: string, passphrase: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, 'utf8'), salt, 32, 16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, ct]).toString('base64');
}

/** Equivalent of `CryptoJS.AES.decrypt(ciphertext, passphrase).toString(CryptoJS.enc.Utf8)`. */
export function cryptoJsAesDecrypt(ciphertextB64: string, passphrase: string): string {
  const data = Buffer.from(ciphertextB64, 'base64');
  if (data.length < 16 || data.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('ciphertext is not in OpenSSL salted format');
  const salt = data.subarray(8, 16);
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, 'utf8'), salt, 32, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8');
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}
