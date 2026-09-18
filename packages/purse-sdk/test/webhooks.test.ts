import { describe, expect, it } from 'vitest';
import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from '@purse/types';

import { constantTimeEqual, parseSignatureHeader, signWebhook, verifyWebhook } from '../src/index';

/**
 * Acceptance criterion 15: a webhook with a bad signature or a timestamp outside the
 * window is rejected. The same helper signs (Purse's dispatcher) and verifies (a partner's
 * receiver), so the two can never disagree on the canonical form.
 */
const SECRET = 'whsec_test_secret_0123456789abcdef';
const BODY = '{"id":"evt_01","type":"contest.settled","data":{"contestId":"cnt_01"}}';
const T = 1_800_000_000;
const NOW = T * 1000;

describe('signWebhook / verifyWebhook', () => {
  it('accepts a signature made with the secret over "{t}.{rawBody}"', async () => {
    const signed = await signWebhook(BODY, SECRET, T);
    expect(signed.header).toBe(`t=${T},v1=${signed.signature}`);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyWebhook(BODY, signed.header, SECRET, { now: NOW })).resolves.toEqual({ ok: true, timestamp: T });
  });

  it('rejects a bad signature, a wrong secret and a tampered body', async () => {
    const signed = await signWebhook(BODY, SECRET, T);
    await expect(verifyWebhook(BODY, `t=${T},v1=${'0'.repeat(64)}`, SECRET, { now: NOW })).resolves.toEqual({ ok: false, reason: 'signature_mismatch' });
    await expect(verifyWebhook(BODY, signed.header, 'whsec_other', { now: NOW })).resolves.toEqual({ ok: false, reason: 'signature_mismatch' });
    await expect(verifyWebhook(BODY.replace('cnt_01', 'cnt_02'), signed.header, SECRET, { now: NOW })).resolves.toEqual({ ok: false, reason: 'signature_mismatch' });
    // A signature over the body alone (without the timestamp) is not the scheme.
    const wrongCanonical = await signWebhook('', SECRET, T);
    await expect(verifyWebhook(BODY, wrongCanonical.header, SECRET, { now: NOW })).resolves.toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a timestamp outside the five-minute window in either direction, whatever the signature', async () => {
    const signed = await signWebhook(BODY, SECRET, T);
    const tolerance = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
    expect(tolerance).toBe(300);
    await expect(verifyWebhook(BODY, signed.header, SECRET, { now: NOW + (tolerance + 1) * 1000 })).resolves.toEqual({ ok: false, reason: 'timestamp_out_of_window' });
    await expect(verifyWebhook(BODY, signed.header, SECRET, { now: NOW - (tolerance + 1) * 1000 })).resolves.toEqual({ ok: false, reason: 'timestamp_out_of_window' });
    await expect(verifyWebhook(BODY, signed.header, SECRET, { now: NOW + tolerance * 1000 })).resolves.toEqual({ ok: true, timestamp: T });
    await expect(verifyWebhook(BODY, signed.header, SECRET, { now: NOW, toleranceSeconds: 10 })).resolves.toEqual({ ok: true, timestamp: T });
    await expect(verifyWebhook(BODY, signed.header, SECRET, { now: NOW + 11_000, toleranceSeconds: 10 })).resolves.toEqual({ ok: false, reason: 'timestamp_out_of_window' });
  });

  it('rejects malformed headers before doing any cryptography', async () => {
    for (const header of [undefined, null, '', 't=abc,v1=00', `v1=${'a'.repeat(64)}`, `t=${T}`, `t=${T},v1=short`, `t=${T},t=${T},v1=${'a'.repeat(64)}`, 'garbage']) {
      await expect(verifyWebhook(BODY, header, SECRET, { now: NOW })).resolves.toEqual({ ok: false, reason: 'malformed_header' });
    }
  });

  it('accepts any one of several v1 signatures (secret rotation) and ignores unknown schemes', async () => {
    const old = await signWebhook(BODY, 'whsec_old', T);
    const fresh = await signWebhook(BODY, SECRET, T);
    const header = `t=${T},v1=${old.signature},v1=${fresh.signature},v2=${'f'.repeat(64)}`;
    expect(parseSignatureHeader(header)).toEqual({ timestamp: T, signatures: [old.signature, fresh.signature] });
    await expect(verifyWebhook(BODY, header, SECRET, { now: NOW })).resolves.toEqual({ ok: true, timestamp: T });
    await expect(verifyWebhook(BODY, header, 'whsec_old', { now: NOW })).resolves.toEqual({ ok: true, timestamp: T });
    await expect(verifyWebhook(BODY, header, 'whsec_neither', { now: NOW })).resolves.toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('compares in constant time over the expected length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a', '')).toBe(false);
  });
});
