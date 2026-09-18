import { describe, expect, it } from 'vitest';

import { parentOriginOf, Receiver } from '../src/embed/receiver';

/**
 * The frame's receiver (spec 4.8 rules 3 and 4): every message is judged on origin,
 * source, schema and nonce, and whatever fails is dropped and counted by reason.
 */
const PARENT = 'http://localhost:3000';
const NONCE = 'n'.repeat(24);
const hello = { v: 1, type: 'hello', nonce: NONCE, flow: 'wallet', publishableKey: `pk_sandbox_${'A'.repeat(32)}`, embedToken: `embt_${'b'.repeat(43)}`, theme: null, context: {} };

describe('Receiver', () => {
  const parentWindow = {} as Window;
  const other = {} as Window;
  const make = () => new Receiver(PARENT, () => parentWindow);

  it('accepts hello from the parent, establishes the nonce, and then requires it', () => {
    const receiver = make();
    expect(receiver.established).toBe(false);
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: hello })).toEqual({ ok: true, message: hello });
    expect(receiver.currentNonce).toBe(NONCE);
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: { v: 1, type: 'resize:request', nonce: NONCE } }).ok).toBe(true);
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: { v: 1, type: 'state:request', nonce: 'x'.repeat(24) } })).toEqual({ ok: false, reason: 'nonce' });
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: hello })).toEqual({ ok: false, reason: 'unexpected' });
    expect(receiver.drops).toMatchObject({ nonce: 1, unexpected: 1, origin: 0 });
  });

  it('drops a message from another origin or another window before looking at it', () => {
    const receiver = make();
    expect(receiver.validate({ origin: 'https://evil.example', source: parentWindow, data: hello })).toEqual({ ok: false, reason: 'origin' });
    expect(receiver.validate({ origin: PARENT, source: other, data: hello })).toEqual({ ok: false, reason: 'origin' });
    expect(receiver.validate({ origin: PARENT, source: null, data: hello })).toEqual({ ok: false, reason: 'origin' });
    expect(receiver.established).toBe(false);
    expect(receiver.drops.origin).toBe(3);
  });

  it('drops and counts what fails the schema, and a request before any hello', () => {
    const receiver = make();
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: { v: 1, type: 'resize:request', nonce: NONCE } })).toEqual({ ok: false, reason: 'nonce' });
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: { ...hello, v: 2 } })).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: { v: 1, type: 'ready' } })).toEqual({ ok: false, reason: 'unknown_type' });
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: { ...hello, publishableKey: 'sk_sandbox_x' } })).toEqual({ ok: false, reason: 'invalid_shape' });
    expect(receiver.validate({ origin: PARENT, source: parentWindow, data: 'hello' })).toEqual({ ok: false, reason: 'not_an_object' });
    expect(receiver.drops).toEqual({ origin: 0, not_an_object: 1, unsupported_version: 1, unknown_type: 1, invalid_shape: 1, nonce: 1, unexpected: 0 });
  });
});

describe('parentOriginOf', () => {
  it('accepts an origin and nothing else', () => {
    expect(parentOriginOf('?flow=wallet&parent=http%3A%2F%2Flocalhost%3A3000')).toBe(PARENT);
    expect(parentOriginOf('?parent=https://sideout.example')).toBe('https://sideout.example');
    for (const bad of ['', '?parent=', '?parent=sideout.example', '?parent=https://sideout.example/app', '?parent=javascript:alert(1)', '?parent=file:///etc', '?parent=https://a.example/']) {
      expect(parentOriginOf(bad), bad).toBeUndefined();
    }
  });
});
