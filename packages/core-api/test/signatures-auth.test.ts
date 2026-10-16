import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cryptoJsAesDecrypt,
  cryptoJsAesEncrypt,
  DEFAULT_SCHEMES,
  FSM_SOURCES,
  signJwt,
  signPayload,
  signState,
  verifyJwt,
  verifySignature,
  verifyState,
} from '../src/index.js';

const body = JSON.stringify({ hello: 'world', amount: 650 });

describe('webhook signatures', () => {
  it.each(FSM_SOURCES)('%s: signPayload output verifies', (source) => {
    const headers = signPayload(source, 's3cret', body);
    expect(verifySignature(source, 's3cret', body, headers)).toEqual({ valid: true });
  });

  it.each(FSM_SOURCES)('%s: tampered body is rejected', (source) => {
    const headers = signPayload(source, 's3cret', body);
    expect(verifySignature(source, 's3cret', body.replace('650', '651'), headers).valid).toBe(false);
  });

  it('Jobber uses base64 HMAC-SHA256 of the raw body in X-Jobber-Hmac-SHA256', () => {
    const expected = createHmac('sha256', 'client-secret').update(body).digest('base64');
    expect(verifySignature('jobber', 'client-secret', body, { 'X-Jobber-Hmac-SHA256': expected }).valid).toBe(true);
  });

  it('Housecall Pro signs `${timestamp}.${body}` and enforces a tolerance window', () => {
    const ts = 1_760_000_000;
    const sig = createHmac('sha256', 'hcp').update(`${ts}.${body}`).digest('hex');
    const headers = { 'Api-Timestamp': String(ts), 'Api-Signature': sig };
    expect(verifySignature('housecallpro', 'hcp', body, headers, { now: ts + 60 }).valid).toBe(true);
    expect(verifySignature('housecallpro', 'hcp', body, headers, { now: ts + 3600 })).toEqual({ valid: false, reason: 'timestamp outside tolerance window' });
  });

  it('Buildertrend requires the sha256= prefix', () => {
    const raw = createHmac('sha256', 'bt').update(body).digest('hex');
    expect(verifySignature('buildertrend', 'bt', body, { [DEFAULT_SCHEMES.buildertrend.header]: raw }).valid).toBe(false);
    expect(verifySignature('buildertrend', 'bt', body, { [DEFAULT_SCHEMES.buildertrend.header]: `sha256=${raw}` }).valid).toBe(true);
  });

  it('reports a missing header and supports per-connection scheme overrides', () => {
    expect(verifySignature('servicetitan', 'x', body, {})).toEqual({ valid: false, reason: 'missing x-servicetitan-signature header' });
    const scheme = { header: 'x-custom-sig', encoding: 'hex' as const };
    const headers = signPayload('servicetitan', 'x', body, { scheme });
    expect(verifySignature('servicetitan', 'x', body, headers, { scheme }).valid).toBe(true);
  });
});

describe('auth primitives', () => {
  it('CryptoJS-compatible AES round-trips (GHL Custom Page SSO)', () => {
    const payload = JSON.stringify({ userId: 'u1', activeLocation: 'loc1' });
    const ct = cryptoJsAesEncrypt(payload, 'shared-secret');
    expect(Buffer.from(ct, 'base64').subarray(0, 8).toString()).toBe('Salted__');
    expect(cryptoJsAesDecrypt(ct, 'shared-secret')).toBe(payload);
    expect(() => cryptoJsAesDecrypt(ct, 'wrong-secret')).toThrow();
  });

  it('decrypts an independently produced OpenSSL/CryptoJS ciphertext', () => {
    // `openssl enc -aes-256-cbc -md md5 -salt -pass pass:secret -base64` — the same EVP_BytesToKey(MD5)
    // format `CryptoJS.AES.encrypt(text, passphrase)` emits and GHL sends in REQUEST_USER_DATA_RESPONSE.
    const fixture = 'U2FsdGVkX19BjPY50VzUd14cXITsCPdPpLEPwkQe+/UJTTJSrBbJdMT/KWdNs77/o5AqU72Z6CXxeqxPjElPOw==';
    expect(JSON.parse(cryptoJsAesDecrypt(fixture, 'secret'))).toEqual({ userId: 'abc', activeLocation: 'loc_123' });
  });

  it('HS256 JWTs verify, expire, and reject tampering', () => {
    const now = Date.now();
    const token = signJwt({ accountId: 42 }, 'k', { expiresInSeconds: 60, now });
    expect(verifyJwt(token, 'k', now)?.accountId).toBe(42);
    expect(verifyJwt(`Bearer ${token}`, 'k', now)?.accountId).toBe(42);
    expect(verifyJwt(token, 'other', now)).toBeNull();
    expect(verifyJwt(token, 'k', now + 120_000)).toBeNull();
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ accountId: 1 })).toString('base64url')}.${s}`;
    expect(verifyJwt(forged, 'k', now)).toBeNull();
  });

  it('OAuth state is signed and time-boxed', () => {
    const state = signState('app', { crm: 'hubspot' }, 1_000);
    expect(verifyState('app', state, 600_000, 2_000)?.crm).toBe('hubspot');
    expect(verifyState('other', state, 600_000, 2_000)).toBeNull();
    expect(verifyState('app', state, 600_000, 1_000_000)).toBeNull();
    expect(verifyState('app', 'garbage')).toBeNull();
  });
});
