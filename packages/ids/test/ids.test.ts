import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ID_PREFIXES,
  InvalidIdError,
  idCheckPattern,
  idRegExp,
  idTimestamp,
  isId,
  newId,
  parseId,
  prefixOf,
} from '../src/index';

const prefixes = Object.values(ID_PREFIXES);

describe('id format', () => {
  it('mints `<prefix>_<uuid v7>` for every registered prefix', () => {
    for (const prefix of prefixes) {
      const id = newId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(id).toMatch(idRegExp(prefix));
      // version nibble 7, RFC 4122 variant
      const uuid = id.slice(prefix.length + 1);
      expect(uuid[14]).toBe('7');
      expect('89ab').toContain(uuid[19]);
    }
  });

  it('keeps prefixes unique across the registry', () => {
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('narrows only ids with the exact prefix', () => {
    const tenant = newId('tnt');
    expect(isId(tenant, 'tnt')).toBe(true);
    expect(isId(tenant, 'usr')).toBe(false);
    expect(isId(tenant.toUpperCase(), 'tnt')).toBe(false);
    expect(isId(`tnt_${crypto.randomUUID()}`, 'tnt')).toBe(false); // v4, not v7
    expect(isId('tnt_', 'tnt')).toBe(false);
    expect(isId(42, 'tnt')).toBe(false);
    expect(isId(null, 'tnt')).toBe(false);
  });

  it('parseId throws a typed error that names the expected prefix', () => {
    expect(() => parseId('nope', 'usr')).toThrow(InvalidIdError);
    expect(() => parseId(newId('tnt'), 'usr')).toThrow(/usr_/);
    const id = newId('usr');
    expect(parseId(id, 'usr')).toBe(id);
  });

  it('prefixOf reads the prefix back', () => {
    expect(prefixOf(newId('acct'))).toBe('acct');
  });

  it('the SQL CHECK pattern agrees with the JavaScript validator', () => {
    fc.assert(
      fc.property(fc.constantFrom(...prefixes), (prefix) => {
        const id = newId(prefix);
        const sqlPattern = new RegExp(idCheckPattern(prefix));
        expect(sqlPattern.test(id)).toBe(true);
        for (const other of prefixes) {
          if (other !== prefix) expect(sqlPattern.test(newId(other))).toBe(false);
        }
      }),
    );
  });
});

describe('time ordering', () => {
  it('ids minted in sequence sort lexicographically in mint order', () => {
    const ids = Array.from({ length: 10_000 }, () => newId('txn'));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the mint instant at millisecond precision', () => {
    const before = Date.now();
    const id = newId('ent');
    const after = Date.now();
    const at = idTimestamp(id).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it('later ids never carry an earlier timestamp', () => {
    const ids = Array.from({ length: 1_000 }, () => newId('cnt'));
    for (let i = 1; i < ids.length; i += 1) {
      expect(idTimestamp(ids[i]!).getTime()).toBeGreaterThanOrEqual(
        idTimestamp(ids[i - 1]!).getTime(),
      );
    }
  });

  it('idTimestamp rejects non-v7 payloads', () => {
    expect(() => idTimestamp(`usr_${crypto.randomUUID()}`)).toThrow(InvalidIdError);
  });
});
