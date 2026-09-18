import { describe, expect, it } from 'vitest';

import { sectionOf } from '../src/components/Nav';
import { formatInstant, shortId } from '../src/lib/format';

describe('console navigation and formatting', () => {
  it('maps every path to the rail section it belongs to', () => {
    expect(sectionOf('/tenants')).toBe('/tenants');
    expect(sectionOf('/tenants/tnt_1')).toBe('/tenants');
    expect(sectionOf('/tenants/tnt_1/webhooks/whe_1')).toBe('/tenants');
    expect(sectionOf('/tenants/tnt_1/contests/cnt_1')).toBe('/contests');
    expect(sectionOf('/tenants/tnt_1/ledger')).toBe('/ledger');
    expect(sectionOf('/accounts/acct_1')).toBe('/ledger');
    expect(sectionOf('/entries/je_1')).toBe('/ledger');
    expect(sectionOf('/rulesets/2026.09.1')).toBe('/rulesets');
    expect(sectionOf('/rulesets/tester')).toBe('/rulesets/tester');
    expect(sectionOf('/webhooks')).toBe('/webhooks');
    expect(sectionOf('/account')).toBe('');
  });

  it('formats instants in UTC and shortens ids by their tail', () => {
    expect(formatInstant('2026-09-18T12:34:56.789Z')).toBe('2026-09-18 12:34:56Z');
    expect(formatInstant(null)).toBe('—');
    expect(shortId('je_01a0b292-9a26-7446-9250-0057d8856e0e')).toBe('je_…856e0e');
  });
});
