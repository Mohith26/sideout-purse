import { describe, expect, it } from 'vitest';

import { DROP_REASONS, MOUNTABLE_FLOWS, PROTOCOL_VERSION, WEBHOOK_EVENT_TYPES, emptyDropCounts, isTokenFlow, parseMessage, themeSchema } from '../src/index';

/**
 * The iframe protocol (spec 4.8): a discriminated union with a version field, validated
 * with Zod on both sides. `parseMessage` says why something was dropped so the receivers'
 * drop counters agree on their reasons.
 */
const NONCE = 'n'.repeat(24);

describe('parseMessage', () => {
  it('is version 1 from the first commit and refuses every other version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(parseMessage('to-parent', { v: 1, type: 'ready' })).toEqual({ ok: true, message: { v: 1, type: 'ready' } });
    expect(parseMessage('to-parent', { v: 2, type: 'ready' })).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(parseMessage('to-parent', { type: 'ready' })).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(parseMessage('to-parent', { v: '1', type: 'ready' })).toEqual({ ok: false, reason: 'unsupported_version' });
  });

  it('classifies non-objects, unknown types and bad shapes', () => {
    for (const value of [null, undefined, 'ready', 1, [], true]) expect(parseMessage('to-parent', value)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(parseMessage('to-parent', { v: 1, type: 'hello' })).toEqual({ ok: false, reason: 'unknown_type' });
    expect(parseMessage('to-embed', { v: 1, type: 'ready' })).toEqual({ ok: false, reason: 'unknown_type' });
    expect(parseMessage('to-parent', { v: 1, type: 'resize', nonce: NONCE, height: -1 })).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseMessage('to-parent', { v: 1, type: 'resize', nonce: NONCE, height: 100, extra: 1 })).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseMessage('to-parent', { v: 1, type: 'resize', nonce: 'short', height: 100 })).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseMessage('to-parent', { v: 1, type: 'ready', nonce: NONCE })).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('accepts every message of each direction', () => {
    const hello = { v: 1, type: 'hello', nonce: NONCE, flow: 'entry', publishableKey: `pk_sandbox_${'A'.repeat(32)}`, embedToken: `embt_${'b'.repeat(43)}`, theme: { accent: '#D7FF3E', surface: '#101216', radius: 10, font: 'Instrument Sans' }, context: { contestId: 'cnt_1' } };
    expect(parseMessage('to-embed', hello)).toEqual({ ok: true, message: hello });
    expect(parseMessage('to-embed', { ...hello, flow: 'signin', embedToken: null, theme: null, context: {} }).ok).toBe(true);
    expect(parseMessage('to-embed', { ...hello, publishableKey: `sk_sandbox_${'A'.repeat(32)}` })).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseMessage('to-embed', { v: 1, type: 'resize:request', nonce: NONCE }).ok).toBe(true);
    expect(parseMessage('to-embed', { v: 1, type: 'state:request', nonce: NONCE }).ok).toBe(true);

    const state = { authenticated: true, user: { id: 'usr_1', externalId: 'x', displayName: null, verification: { state: 'verified', provider: 'dev', verifiedAt: '2026-09-18T00:00:00.000Z', reverifyAfter: null }, restrictions: [], wallet: [{ asset: 'POINTS', balance: '10', accountId: null }] } };
    expect(parseMessage('to-parent', { v: 1, type: 'hello_ack', nonce: NONCE, flow: 'entry', state }).ok).toBe(true);
    expect(parseMessage('to-parent', { v: 1, type: 'hello_ack', nonce: NONCE, flow: 'entry', state: { authenticated: false, user: null } }).ok).toBe(true);
    expect(parseMessage('to-parent', { v: 1, type: 'hello_ack', nonce: NONCE, flow: 'entry', state: { authenticated: true, user: null } })).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(parseMessage('to-parent', { v: 1, type: 'state', nonce: NONCE, state }).ok).toBe(true);
    expect(parseMessage('to-parent', { v: 1, type: 'resize', nonce: NONCE, height: 320 }).ok).toBe(true);
    expect(parseMessage('to-parent', { v: 1, type: 'flow:complete', nonce: NONCE, result: { flow: 'entry', userId: 'usr_1', contestId: 'cnt_1', participantId: 'ent_1', journalEntryId: 'je_1' } }).ok).toBe(true);
    expect(parseMessage('to-parent', { v: 1, type: 'flow:complete', nonce: NONCE, result: { flow: 'entry', userId: 'usr_1' } })).toEqual({ ok: false, reason: 'invalid_shape' });
    const notEligible = { type: 'not_eligible', code: 'not_eligible', message: 'no', detail: { reasons: ['identity_unverified'], requiredAction: 'complete_identity' } };
    expect(parseMessage('to-parent', { v: 1, type: 'error', nonce: NONCE, error: notEligible, fatal: false }).ok).toBe(true);
    expect(parseMessage('to-parent', { v: 1, type: 'error', nonce: NONCE, error: { ...notEligible, type: 'made_up' }, fatal: false })).toEqual({ ok: false, reason: 'invalid_shape' });
  });
});

describe('embed vocabulary', () => {
  it('lists the mountable flows and which take a token', () => {
    expect(MOUNTABLE_FLOWS).toEqual(['signin', 'identity', 'wallet', 'entry', 'rewards']);
    expect(isTokenFlow('signin')).toBe(false);
    expect(isTokenFlow('wallet')).toBe(true);
  });

  it('holds a theme to colours, a small radius and a plain font name', () => {
    expect(themeSchema.safeParse({}).success).toBe(true);
    expect(themeSchema.safeParse({ accent: '#d7ff3e', surface: '#101216', radius: 0, font: "Instrument Sans, 'Helvetica Neue'" }).success).toBe(true);
    for (const bad of [{ accent: 'volt' }, { accent: '#fff' }, { radius: 25 }, { radius: 1.5 }, { font: 'x;}' }, { font: 'url(x)' }, { extra: 1 }]) {
      expect(themeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('starts every drop counter at zero', () => {
    const counts = emptyDropCounts();
    expect(Object.keys(counts).sort()).toEqual([...DROP_REASONS].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe('webhook vocabulary', () => {
  it('is exactly the spec 4.9 list', () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual(
      ['user.verification.updated', 'contest.opened', 'contest.locked', 'contest.settled', 'contest.entry.created', 'contest.voided', 'contest.entry.withdrawn', 'wallet.balance.changed'].sort(),
    );
  });
});
