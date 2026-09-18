// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type EmbedUserState, type ToEmbedMessage } from '@purse/types';

import { DEFAULT_ORIGINS, Purse, PurseError, type Mounted } from '../src/index';

/**
 * The SDK against a jsdom window. The frame is never loaded (jsdom loads no
 * subresources); its side of the conversation is played by dispatching `MessageEvent`s
 * on the window with the origin and source a real frame would have, and what the SDK
 * sends is captured by spying on the frame's `contentWindow.postMessage`, target origin
 * included. Acceptance criterion 13 (a wrong origin is dropped and counted) and spec 4.8
 * rules 2, 3, 4 and 6 are the cases.
 */
const PK = 'pk_sandbox_' + 'A'.repeat(32);
const TENANT = 'tnt_019a0b16-b475-74d4-b1cb-2dbdc08845a9';
const ORIGIN = 'http://localhost:4000';
const TOKEN = 'embt_' + 'b'.repeat(43);

const authenticated: EmbedUserState = {
  authenticated: true,
  user: {
    id: 'usr_019a0b16-b475-74d4-b1cb-2dbdc08845a9',
    externalId: 'sideout:ana',
    displayName: 'Ana',
    verification: { state: 'verified', provider: 'dev', verifiedAt: '2026-09-18T00:00:00.000Z', reverifyAfter: null },
    restrictions: [],
    wallet: [{ asset: 'POINTS', balance: '1000', accountId: 'acct_019a0b16-b475-74d4-b1cb-2dbdc08845a9' }],
  },
};

type Sent = { message: ToEmbedMessage; targetOrigin: string };

function setup() {
  document.body.innerHTML = '<div id="slot"></div>';
  const sent: Sent[] = [];
  return {
    sent,
    /** Spy on the frame the SDK created; returns what it sends. */
    spy(frame: HTMLIFrameElement) {
      const target = frame.contentWindow;
      if (target === null) throw new Error('jsdom gave the frame no contentWindow');
      vi.spyOn(target, 'postMessage').mockImplementation((message: unknown, targetOrigin?: unknown) => {
        sent.push({ message: message as ToEmbedMessage, targetOrigin: String(targetOrigin) });
      });
      return target;
    },
    /** A message as the frame would send it: from the Purse origin, from the frame's window. */
    fromFrame(frame: HTMLIFrameElement, data: unknown, origin = ORIGIN, source: Window | null = frame.contentWindow) {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    },
  };
}

async function mountAndReady(purse: Purse, env: ReturnType<typeof setup>, options: { flow?: 'identity' | 'entry' | 'signin' | 'wallet' | 'rewards'; contestId?: string } = {}) {
  const flow = options.flow ?? 'identity';
  const mounting = purse.mount('#slot', { flow, ...(flow === 'signin' ? {} : { embedToken: TOKEN }), ...(options.contestId === undefined ? {} : { contestId: options.contestId }) });
  const frame = document.querySelector('iframe');
  if (frame === null) throw new Error('no iframe');
  env.spy(frame);
  env.fromFrame(frame, { v: PROTOCOL_VERSION, type: 'ready' });
  const hello = env.sent.at(-1)?.message;
  if (hello?.type !== 'hello') throw new Error(`expected hello, got ${JSON.stringify(hello)}`);
  return { mounting, frame, hello, nonce: hello.nonce };
}

describe('Purse.init', () => {
  it('resolves the origin from the key environment and accepts an override', async () => {
    const live = await Purse.init({ publishableKey: 'pk_live_' + 'x'.repeat(32), tenantId: TENANT });
    expect(live.origin).toBe(DEFAULT_ORIGINS.live);
    const sandbox = await Purse.init({ publishableKey: PK, tenantId: TENANT });
    expect(sandbox.origin).toBe(DEFAULT_ORIGINS.sandbox);
    const local = await Purse.init({ publishableKey: PK, tenantId: TENANT, purseOrigin: 'http://localhost:4000/' });
    expect(local.origin).toBe(ORIGIN);
  });

  it('refuses a secret key, a malformed key, a bad origin, a bad tenant id and a bad theme', async () => {
    await expect(Purse.init({ publishableKey: 'sk_sandbox_' + 'A'.repeat(32), tenantId: TENANT })).rejects.toMatchObject({ type: 'invalid_request', code: 'invalid_init_options' });
    await expect(Purse.init({ publishableKey: 'pk_sandbox_short', tenantId: TENANT })).rejects.toMatchObject({ code: 'invalid_init_options' });
    await expect(Purse.init({ publishableKey: PK, tenantId: TENANT, purseOrigin: 'localhost:4000' })).rejects.toMatchObject({ code: 'invalid_init_options' });
    await expect(Purse.init({ publishableKey: PK, tenantId: TENANT, purseOrigin: 'http://localhost:4000/embed' })).rejects.toMatchObject({ code: 'invalid_init_options' });
    await expect(Purse.init({ publishableKey: PK, tenantId: 'sideout' })).rejects.toMatchObject({ code: 'invalid_tenant_id' });
    await expect(Purse.init({ publishableKey: PK, tenantId: TENANT, theme: { accent: 'red' } })).rejects.toMatchObject({ code: 'invalid_init_options' });
    await expect(Purse.init({ publishableKey: PK, tenantId: TENANT, theme: { font: 'x; } body { display: none' } })).rejects.toMatchObject({ code: 'invalid_init_options' });
  });
});

describe('mount and the handshake', () => {
  let purse: Purse;
  let env: ReturnType<typeof setup>;
  beforeEach(async () => {
    env = setup();
    purse = await Purse.init({ publishableKey: PK, tenantId: TENANT, purseOrigin: ORIGIN, theme: { accent: '#D7FF3E', radius: 10 }, handshakeTimeoutMs: 200 });
  });
  afterEach(() => {
    purse.unmount();
    vi.restoreAllMocks();
  });

  it('creates the frame on the Purse origin and answers ready with hello, to the exact origin, with the token and theme', async () => {
    const { mounting, frame, hello } = await mountAndReady(purse, env, { flow: 'entry', contestId: 'cnt_1' });
    const src = new URL(frame.src);
    expect(src.origin).toBe(ORIGIN);
    expect(src.pathname).toBe('/embed/');
    expect(src.searchParams.get('flow')).toBe('entry');
    expect(src.searchParams.get('parent')).toBe(window.location.origin);
    expect(frame.getAttribute('scrolling')).toBe('no');
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.targetOrigin).toBe(ORIGIN);
    expect(hello).toMatchObject({ v: 1, type: 'hello', flow: 'entry', publishableKey: PK, embedToken: TOKEN, theme: { accent: '#D7FF3E', radius: 10 }, context: { contestId: 'cnt_1' } });
    expect(hello.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

    env.fromFrame(frame, { v: 1, type: 'hello_ack', nonce: hello.nonce, flow: 'entry', state: authenticated });
    const mounted: Mounted = await mounting;
    expect(mounted).toMatchObject({ flow: 'entry', state: authenticated });
    expect(purse.drops).toEqual({ origin: 0, not_an_object: 0, unsupported_version: 0, unknown_type: 0, invalid_shape: 0, nonce: 0, unexpected: 0 });
  });

  it('drops and counts a message from a non-allowlisted origin, and never answers it', async () => {
    const mounting = purse.mount('#slot', { flow: 'identity', embedToken: TOKEN });
    const frame = document.querySelector('iframe');
    if (frame === null) throw new Error('no iframe');
    env.spy(frame);
    env.fromFrame(frame, { v: 1, type: 'ready' }, 'https://evil.example');
    env.fromFrame(frame, { v: 1, type: 'ready' }, 'http://localhost:4001');
    expect(env.sent).toHaveLength(0);
    expect(purse.drops.origin).toBe(2);
    // The right origin but another window (a second frame on the Purse origin) is not our frame either.
    env.fromFrame(frame, { v: 1, type: 'ready' }, ORIGIN, null);
    expect(env.sent).toHaveLength(0);
    expect(purse.drops.origin).toBe(3);
    // The real frame's ready still works afterwards.
    env.fromFrame(frame, { v: 1, type: 'ready' });
    expect(env.sent).toHaveLength(1);
    await expect(mounting).rejects.toMatchObject({ code: 'embed_timeout' });
  });

  it('drops and counts a message with a missing or stale nonce', async () => {
    const { mounting, frame, nonce } = await mountAndReady(purse, env);
    env.fromFrame(frame, { v: 1, type: 'hello_ack', nonce: 'stale-stale-stale-stale', flow: 'identity', state: authenticated });
    expect(purse.drops.nonce).toBe(1);
    env.fromFrame(frame, { v: 1, type: 'resize', height: 300 });
    expect(purse.drops.invalid_shape).toBe(1);
    expect(frame.style.height).toBe('480px');
    env.fromFrame(frame, { v: 1, type: 'hello_ack', nonce, flow: 'identity', state: authenticated });
    await expect(mounting).resolves.toMatchObject({ flow: 'identity' });
    const resized = vi.fn();
    purse.on('resize', resized);
    env.fromFrame(frame, { v: 1, type: 'resize', nonce: `${nonce}x`, height: 300 });
    expect(frame.style.height).toBe('480px');
    expect(resized).not.toHaveBeenCalled();
    expect(purse.drops.nonce).toBe(2);
  });

  it('drops and counts anything that fails the schema: wrong version, unknown type, bad shape, not an object', async () => {
    const { mounting, frame, nonce } = await mountAndReady(purse, env);
    env.fromFrame(frame, { v: 1, type: 'hello_ack', nonce, flow: 'identity', state: authenticated });
    await mounting;
    env.fromFrame(frame, { v: 2, type: 'resize', nonce, height: 1 });
    env.fromFrame(frame, { v: 1, type: 'eval', nonce });
    env.fromFrame(frame, { v: 1, type: 'resize', nonce, height: 'tall' });
    env.fromFrame(frame, { v: 1, type: 'resize', nonce, height: 1, extra: true });
    env.fromFrame(frame, 'resize');
    env.fromFrame(frame, null);
    env.fromFrame(frame, [1]);
    expect(purse.drops).toMatchObject({ unsupported_version: 1, unknown_type: 1, invalid_shape: 2, not_an_object: 3 });
  });

  it('honours resize reports and relays resize requests with the nonce', async () => {
    const { mounting, frame, nonce } = await mountAndReady(purse, env);
    env.fromFrame(frame, { v: 1, type: 'hello_ack', nonce, flow: 'identity', state: authenticated });
    await mounting;
    const resized = vi.fn();
    purse.on('resize', resized);
    env.fromFrame(frame, { v: 1, type: 'resize', nonce, height: 612 });
    expect(frame.style.height).toBe('612px');
    expect(resized).toHaveBeenCalledWith({ height: 612 });
    purse.requestResize();
    expect(env.sent.at(-1)).toEqual({ message: { v: 1, type: 'resize:request', nonce }, targetOrigin: ORIGIN });
  });

  it('relays flow:complete and error with the sealed variants, and a fatal error fails the mount', async () => {
    const { mounting, frame, nonce } = await mountAndReady(purse, env);
    const errors = vi.fn();
    purse.on('error', errors);
    const fatal = { type: 'authentication_error', code: 'embed_token_used', message: 'The embed token was already used' };
    env.fromFrame(frame, { v: 1, type: 'error', nonce, error: fatal, fatal: true });
    await expect(mounting).rejects.toBeInstanceOf(PurseError);
    await expect(mounting).rejects.toMatchObject({ type: 'authentication_error', code: 'embed_token_used' });
    expect(errors).toHaveBeenCalledWith(fatal);

    const second = await mountAndReady(purse, env, { flow: 'entry', contestId: 'cnt_1' });
    env.fromFrame(second.frame, { v: 1, type: 'hello_ack', nonce: second.nonce, flow: 'entry', state: authenticated });
    await second.mounting;
    const notEligible = { type: 'not_eligible', code: 'not_eligible', message: 'Not eligible', detail: { reasons: ['identity_unverified'], requiredAction: 'complete_identity', rulesetVersion: '2026.09.1' } };
    env.fromFrame(second.frame, { v: 1, type: 'error', nonce: second.nonce, error: notEligible, fatal: false });
    expect(errors).toHaveBeenLastCalledWith(notEligible);
    const completed = vi.fn();
    const off = purse.on('flow:complete', completed);
    const result = { flow: 'entry', userId: authenticated.user?.id, contestId: 'cnt_1', participantId: 'ent_1', journalEntryId: 'je_1' };
    env.fromFrame(second.frame, { v: 1, type: 'flow:complete', nonce: second.nonce, result });
    expect(completed).toHaveBeenCalledWith(result);
    off();
    env.fromFrame(second.frame, { v: 1, type: 'flow:complete', nonce: second.nonce, result });
    expect(completed).toHaveBeenCalledTimes(1);
    // A result for another flow is not this mount's.
    env.fromFrame(second.frame, { v: 1, type: 'flow:complete', nonce: second.nonce, result: { flow: 'wallet', userId: 'usr_1' } });
    expect(purse.drops.unexpected).toBe(1);
  });

  it('fails the mount when the frame never answers, and refuses obviously wrong mounts up front', async () => {
    const errors = vi.fn();
    purse.on('error', errors);
    await expect(purse.mount('#slot', { flow: 'identity', embedToken: TOKEN })).rejects.toMatchObject({ type: 'internal_error', code: 'embed_timeout' });
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'embed_timeout' }));
    await expect(purse.mount('#missing', { flow: 'identity', embedToken: TOKEN })).rejects.toMatchObject({ code: 'slot_not_found' });
    await expect(purse.mount('#slot', { flow: 'wallet' })).rejects.toMatchObject({ code: 'embed_token_required' });
    await expect(purse.mount('#slot', { flow: 'entry', embedToken: TOKEN })).rejects.toMatchObject({ code: 'contest_id_required' });
    await expect(purse.mount('#slot', { flow: 'admin' as 'wallet', embedToken: TOKEN })).rejects.toMatchObject({ code: 'unknown_flow' });
  });

  it('reads user state through the frame once mounted', async () => {
    const { mounting, frame, nonce } = await mountAndReady(purse, env, { flow: 'signin' });
    expect(env.sent[0]?.message).toMatchObject({ type: 'hello', flow: 'signin', embedToken: null });
    env.fromFrame(frame, { v: 1, type: 'hello_ack', nonce, flow: 'signin', state: { authenticated: false, user: null } });
    await mounting;
    const reading = purse.getUserState();
    expect(env.sent.at(-1)).toEqual({ message: { v: 1, type: 'state:request', nonce }, targetOrigin: ORIGIN });
    env.fromFrame(frame, { v: 1, type: 'state', nonce, state: authenticated });
    await expect(reading).resolves.toEqual(authenticated);
  });
});

describe('headless getUserState', () => {
  it('reads GET /v1/embed/state on the Purse origin with the publishable key and credentials', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: authenticated }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const purse = await Purse.init({ publishableKey: PK, tenantId: TENANT, purseOrigin: ORIGIN, fetch: fetchImpl });
    await expect(purse.getUserState()).resolves.toEqual(authenticated);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/embed/state`);
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'include', mode: 'cors', headers: { Authorization: `Bearer ${PK}` } });
  });

  it('maps an error envelope to the sealed shape and emits it', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' } }), { status: 401 });
    const purse = await Purse.init({ publishableKey: PK, tenantId: TENANT, purseOrigin: ORIGIN, fetch: fetchImpl });
    const errors = vi.fn();
    purse.on('error', errors);
    await expect(purse.getUserState()).rejects.toMatchObject({ type: 'authentication_error', code: 'invalid_api_key' });
    expect(errors).toHaveBeenCalledWith({ type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' });
  });
});
