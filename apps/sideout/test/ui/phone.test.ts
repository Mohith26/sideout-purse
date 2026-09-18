import { describe, expect, it } from 'vitest';

import { maskPhone, normalizePhone } from '../../src/lib/phone';

describe('normalizePhone', () => {
  it('turns what a person types into E.164 or nothing', () => {
    expect(normalizePhone('(415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('1 415 555 0100')).toBe('+14155550100');
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('555-0100')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('maskPhone', () => {
  it('shows the country code and the last four digits, nothing between', () => {
    expect(maskPhone('+14155550100')).toBe('+1 ••• 0100');
    expect(maskPhone('+79161234567')).toBe('+7 ••• 4567');
    expect(maskPhone('+447700900123')).toBe('+44 ••• 0123');
  });
});
