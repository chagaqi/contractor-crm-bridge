import { describe, expect, it } from 'vitest';
import { collectEmails, collectPhones, formatNational, normalizeEmail, toE164 } from '../src/index.js';

describe('toE164 — E.164 phone normalization', () => {
  it.each([
    ['(512) 555-0142', '+15125550142'],
    ['512.555.0142', '+15125550142'],
    ['512-555-0142', '+15125550142'],
    ['5125550142', '+15125550142'],
    ['1-512-555-0142', '+15125550142'],
    ['1 (512) 555-0142', '+15125550142'],
    ['+1 512 555 0142', '+15125550142'],
    ['+15125550142', '+15125550142'],
    ['tel:+15125550142', '+15125550142'],
    ['214-555-0171 ext 4', '+12145550171'],
    ['(214) 555-0171 x123', '+12145550171'],
    ['214-555-0171 ext. 99', '+12145550171'],
    ['214 555 0171 #7', '+12145550171'],
    [5125550142, '+15125550142'],
    ['+44 20 7946 0958', '+442079460958'],
    ['0044 20 7946 0958', '+442079460958'],
    ['011 44 20 7946 0958', '+442079460958'],
    ['+61 2 9374 4000', '+61293744000'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['   '],
    ['555-0142'],
    ['012-555-0142'],
    ['512-055-0142'],
    ['911-555-0142'],
    ['1-800-FLOWERS'],
    ['1111111111'],
    ['+1 012 555 0142'],
    ['+123'],
    ['+1234567890123456'],
    [{ phone: '5125550142' }],
    ['51255501421'],
  ])('rejects %j', (input) => {
    expect(toE164(input)).toBeNull();
  });

  it('collectPhones dedupes and preserves preference order', () => {
    expect(collectPhones(['(512) 555-0142', null, '+15125550142', '737-555-0119', 'junk'])).toEqual(['+15125550142', '+17375550119']);
  });

  it('formatNational renders NANP numbers for humans and passes through others', () => {
    expect(formatNational('+15125550142')).toBe('(512) 555-0142');
    expect(formatNational('+442079460958')).toBe('+442079460958');
    expect(formatNational(null)).toBeNull();
  });
});

describe('email normalization', () => {
  it('lower-cases, trims and strips mailto:', () => {
    expect(normalizeEmail('  PRaman@Example.org ')).toBe('praman@example.org');
    expect(normalizeEmail('mailto:Jane@Example.com')).toBe('jane@example.com');
  });

  it('rejects invalid emails', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it('collectEmails dedupes case-insensitively', () => {
    expect(collectEmails(['A@x.com', 'a@x.com', 'b@x.com', ''])).toEqual(['a@x.com', 'b@x.com']);
  });
});
