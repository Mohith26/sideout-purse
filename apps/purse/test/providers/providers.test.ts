import { describe, expect, it } from 'vitest';

import { SPEC_EXAMPLE_RULESET } from '../../src/eligibility';
import { assessDev, createProviders, devIdentityProvider, DEV_GEO_IP_PREFIXES, ProviderConfigError, resolveDev, type RiskTransaction } from '../../src/providers';

/**
 * Spec 4.5 provider seams: each interface has a deterministic dev implementation, and a
 * production process refuses to run on one by accident.
 */
const request = (overrides: Partial<Parameters<ReturnType<typeof devIdentityProvider>['verify']>[0]> = {}) => ({
  userId: 'usr_1',
  tenantId: 'tnt_1',
  externalId: 'ext',
  displayName: 'Ana Reyes',
  dateOfBirth: '1994-03-12',
  phoneE164: null,
  ...overrides,
});

describe('dev IdentityProvider (Persona / Socure seam)', () => {
  const provider = devIdentityProvider({ allow: ['vip'], deny: ['banned'], pending: ['waiting'] });

  it('decides from the seeded lists, then from whether demographics were supplied', async () => {
    expect((await provider.verify(request({ externalId: 'banned' }))).outcome).toBe('rejected');
    expect((await provider.verify(request({ externalId: 'waiting' }))).outcome).toBe('pending');
    expect((await provider.verify(request({ externalId: 'vip', displayName: null, dateOfBirth: null }))).outcome).toBe('verified');
    expect((await provider.verify(request())).outcome).toBe('verified');
    expect((await provider.verify(request({ dateOfBirth: null }))).outcome).toBe('rejected');
    expect((await provider.verify(request({ displayName: ' ' }))).outcome).toBe('rejected');
    // The deny list wins over everything.
    expect((await devIdentityProvider({ allow: ['x'], deny: ['x'] }).verify(request({ externalId: 'x' }))).outcome).toBe('rejected');
  });

  it('is deterministic and returns an opaque, token-shaped reference that says nothing about the user', async () => {
    const first = await provider.verify(request());
    const second = await provider.verify(request());
    expect(second).toEqual(first);
    expect(first.providerRef).toMatch(/^dev-[0-9a-f]{24}$/);
    expect(first.providerRef).not.toContain('Ana');
    expect(first.providerRef).not.toContain('1994');
    expect(provider.name).toBe('dev');
  });
});

describe('dev GeoProvider (GeoComply seam)', () => {
  it('reads a declared region first, then the documentation IP table, else no region', () => {
    expect(resolveDev({ declaredRegion: 'us-tx' })).toEqual({ region: 'US-TX', confidence: 0.6, source: 'declared' });
    expect(resolveDev({ declaredRegion: 'US-TX', ip: '198.51.100.1' })).toEqual({ region: 'US-TX', confidence: 0.6, source: 'declared' });
    for (const [prefix, region] of DEV_GEO_IP_PREFIXES) {
      expect(resolveDev({ ip: `${prefix}42` })).toEqual({ region, confidence: 0.9, source: 'ip' });
    }
    expect(resolveDev({ ip: '127.0.0.1' })).toEqual({ region: null, confidence: 0, source: 'ip' });
    expect(resolveDev({ ip: '10.1.2.3' })).toEqual({ region: null, confidence: 0, source: 'ip' });
    expect(resolveDev({ declaredRegion: 'not a code', ip: '10.1.2.3' })).toEqual({ region: null, confidence: 0, source: 'ip' });
    expect(resolveDev({})).toEqual({ region: null, confidence: 0, source: 'ip' });
  });
});

describe('dev RiskProvider (Sardine seam)', () => {
  const transaction = (overrides: Partial<RiskTransaction> = {}): RiskTransaction => ({
    tenantId: 'tnt_1',
    userId: 'usr_1',
    contestId: 'cnt_1',
    asset: 'CREDIT',
    amount: 100n,
    velocity: { enteredLast24h: 0n, enteredLast7d: 0n },
    openFlags: [],
    accountAgeMs: 30 * 86_400_000,
    ruleset: SPEC_EXAMPLE_RULESET,
    ...overrides,
  });

  it('allows a quiet entry and asks for review, never denial, on the 4.6 signals', () => {
    expect(assessDev(transaction())).toEqual({ decision: 'allow', signals: [] });
    const near = assessDev(transaction({ velocity: { enteredLast24h: 159_900n, enteredLast7d: 159_900n } }));
    expect(near.decision).toBe('review');
    expect(near.signals.map((signal) => signal.code)).toEqual(['velocity_near_24h_limit']);
    const week = assessDev(transaction({ velocity: { enteredLast24h: 0n, enteredLast7d: 800_000n } }));
    expect(week.signals.map((signal) => signal.code)).toEqual(['velocity_near_7d_limit']);
    const duplicate = assessDev(transaction({ openFlags: ['duplicate_identity'] }));
    expect(duplicate.signals.map((signal) => signal.code)).toEqual(['duplicate_identity_open']);
    const fresh = assessDev(transaction({ accountAgeMs: 1_000, amount: 50_000n }));
    expect(fresh.signals.map((signal) => signal.code)).toEqual(['new_account_max_stake']);
    const everything = assessDev(transaction({ accountAgeMs: 0, amount: 50_000n, openFlags: ['duplicate_identity'], velocity: { enteredLast24h: 150_000n, enteredLast7d: 950_000n } }));
    expect(everything.decision).toBe('review');
    expect(everything.signals).toHaveLength(4);
    expect(everything.signals.every((signal) => !JSON.stringify(signal.detail ?? {}).includes('undefined'))).toBe(true);
    // No limit, no signal.
    const unlimited = assessDev(transaction({ ruleset: { ...SPEC_EXAMPLE_RULESET, stakeLimits: { perContest: null, per24h: null, per7d: null } }, velocity: { enteredLast24h: 10n ** 9n, enteredLast7d: 10n ** 9n } }));
    expect(unlimited.decision).toBe('allow');
  });
});

describe('createProviders', () => {
  it('builds the dev seams outside production and refuses them in production unless allowed explicitly', () => {
    const dev = createProviders({ identity: 'dev', geo: 'dev', risk: 'dev', nodeEnv: 'development', allowDevProviders: false });
    expect([dev.identity.name, dev.geo.name, dev.risk.name]).toEqual(['dev', 'dev', 'dev']);
    expect(() => createProviders({ identity: 'dev', geo: 'dev', risk: 'dev', nodeEnv: 'production', allowDevProviders: false })).toThrow(ProviderConfigError);
    expect(() => createProviders({ identity: 'dev', geo: 'dev', risk: 'dev', nodeEnv: 'production', allowDevProviders: false })).toThrow(/identity, geo, risk/);
    const demo = createProviders({ identity: 'dev', geo: 'dev', risk: 'dev', nodeEnv: 'production', allowDevProviders: true, devIdentity: { deny: ['x'] } });
    expect(demo.identity.name).toBe('dev');
  });
});
