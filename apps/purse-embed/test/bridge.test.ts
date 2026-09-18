import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedUserState, ToParentMessage } from '@purse/types';

import { EmbedApi } from '../src/embed/api';
import { Bridge, type BridgeStatus } from '../src/embed/bridge';

/**
 * The frame's side of the handshake against a jsdom window standing in for the parent:
 * the allowlist is checked before `ready`, `hello` redeems the token and is answered with
 * `hello_ack`, every message out targets the parent origin exactly, and a rejected origin
 * is never spoken to.
 */
const PARENT = 'http://localhost:3000';
const PK = `pk_sandbox_${'A'.repeat(32)}`;
const TOKEN = `embt_${'b'.repeat(43)}`;
const NONCE = 'n'.repeat(24);

const authenticated: EmbedUserState = {
  authenticated: true,
  user: { id: 'usr_1', externalId: 'ana', displayName: 'Ana', verification: { state: 'verified', provider: 'dev', verifiedAt: null, reverifyAfter: null }, restrictions: [], wallet: [] },
};

type Call = { method: string; path: string; body: unknown };

function fakeApi(origins: string[], calls: Call[]): EmbedApi {
  const fetchImpl: typeof fetch = (input, init) => {
    const path = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method: init?.method ?? 'GET', path, body });
    const answer = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify({ data }), { status }));
    if (path.endsWith('/origins')) return answer({ origins });
    if (path.endsWith('/session')) {
      if ((body as { embedToken: string }).embedToken === TOKEN) return answer(authenticated, 201);
      return Promise.resolve(new Response(JSON.stringify({ error: { type: 'authentication_error', code: 'embed_token_used', message: 'used' } }), { status: 401 }));
    }
    if (path.endsWith('/state')) return answer({ authenticated: false, user: null });
    return answer({});
  };
  return new EmbedApi(PK, fetchImpl);
}

describe('Bridge', () => {
  let sent: Array<{ message: ToParentMessage; targetOrigin: string }>;
  let parentWindow: Window;
  let win: Window;
  beforeEach(() => {
    sent = [];
    parentWindow = { postMessage: (message: unknown, targetOrigin: string) => sent.push({ message: message as ToParentMessage, targetOrigin }) } as unknown as Window;
    const search = `?flow=wallet&parent=${encodeURIComponent(PARENT)}&pk=${PK}&v=1`;
    win = new Proxy(window, {
      get(target, property) {
        if (property === 'parent') return parentWindow;
        if (property === 'location') return { ...target.location, search, origin: 'http://localhost:4000' };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const statuses = (bridge: Bridge): BridgeStatus[] => {
    const seen: BridgeStatus[] = [];
    bridge.subscribe((status) => seen.push(status));
    return seen;
  };

  const fromParent = (data: unknown, origin = PARENT, source: Window | null = parentWindow) => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  };

  it('checks the allowlist, posts ready to the parent origin exactly, redeems the token on hello and answers hello_ack', async () => {
    const calls: Call[] = [];
    const bridge = new Bridge({ win, api: fakeApi([PARENT], calls), measure: () => 321 });
    const seen = statuses(bridge);
    await bridge.start();
    expect(seen.map((status) => status.phase)).toEqual(['starting', 'waiting']);
    expect(sent).toEqual([{ message: { v: 1, type: 'ready' }, targetOrigin: PARENT }]);

    fromParent({ v: 1, type: 'hello', nonce: NONCE, flow: 'wallet', publishableKey: PK, embedToken: TOKEN, theme: { accent: '#D7FF3E' }, context: {} });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(3));
    expect(calls.find((call) => call.path.endsWith('/session'))?.body).toEqual({ embedToken: TOKEN, flow: 'wallet', parentOrigin: PARENT });
    expect(sent[1]).toEqual({ message: { v: 1, type: 'hello_ack', nonce: NONCE, flow: 'wallet', state: authenticated }, targetOrigin: PARENT });
    expect(sent[2]).toEqual({ message: { v: 1, type: 'resize', nonce: NONCE, height: 321 }, targetOrigin: PARENT });
    expect(bridge.current).toMatchObject({ phase: 'ready', flow: 'wallet', state: authenticated, theme: { accent: '#D7FF3E' } });
    expect(document.documentElement.style.getPropertyValue('--volt')).toBe('#d7ff3e');

    // Later messages carry the nonce, and every reply targets the parent origin.
    fromParent({ v: 1, type: 'resize:request', nonce: NONCE });
    expect(sent.at(-1)).toEqual({ message: { v: 1, type: 'resize', nonce: NONCE, height: 321 }, targetOrigin: PARENT });
    fromParent({ v: 1, type: 'state:request', nonce: NONCE });
    await vi.waitFor(() => expect(sent.at(-1)?.message.type).toBe('state'));
    bridge.complete({ flow: 'wallet', userId: 'usr_1' });
    expect(sent.at(-1)).toEqual({ message: { v: 1, type: 'flow:complete', nonce: NONCE, result: { flow: 'wallet', userId: 'usr_1' } }, targetOrigin: PARENT });
    expect(sent.every((each) => each.targetOrigin === PARENT)).toBe(true);
    bridge.stop();
  });

  it('never speaks to a parent that is not on the allowlist, and drops messages from anyone else', async () => {
    const bridge = new Bridge({ win, api: fakeApi(['https://elsewhere.example'], []) });
    await bridge.start();
    expect(bridge.current).toEqual({ phase: 'refused', reason: 'origin_not_allowed', detail: PARENT });
    expect(sent).toEqual([]);

    const allowed = new Bridge({ win, api: fakeApi([PARENT], []) });
    await allowed.start();
    fromParent({ v: 1, type: 'hello', nonce: NONCE, flow: 'wallet', publishableKey: PK, embedToken: TOKEN, theme: null, context: {} }, 'https://evil.example');
    fromParent({ v: 1, type: 'hello', nonce: NONCE, flow: 'wallet', publishableKey: PK, embedToken: TOKEN, theme: null, context: {} }, PARENT, null);
    fromParent({ v: 1, type: 'resize:request', nonce: NONCE });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(allowed.drops).toMatchObject({ origin: 2, nonce: 1 });
    expect(sent).toEqual([{ message: { v: 1, type: 'ready' }, targetOrigin: PARENT }]);
    expect(allowed.current.phase).toBe('waiting');
    allowed.stop();
  });

  it('a refused token is a fatal error to the parent, in the sealed shape', async () => {
    const bridge = new Bridge({ win, api: fakeApi([PARENT], []) });
    await bridge.start();
    fromParent({ v: 1, type: 'hello', nonce: NONCE, flow: 'wallet', publishableKey: PK, embedToken: `embt_${'z'.repeat(43)}`, theme: null, context: {} });
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]).toEqual({ message: { v: 1, type: 'error', nonce: NONCE, error: { type: 'authentication_error', code: 'embed_token_used', message: 'used' }, fatal: true }, targetOrigin: PARENT });
    expect(bridge.current).toEqual({ phase: 'failed', error: { type: 'authentication_error', code: 'embed_token_used', message: 'used' } });
    bridge.stop();
  });

  it('refuses a hello for another key or flow, and a token flow opened without a token', async () => {
    const bridge = new Bridge({ win, api: fakeApi([PARENT], []) });
    await bridge.start();
    fromParent({ v: 1, type: 'hello', nonce: NONCE, flow: 'rewards', publishableKey: PK, embedToken: TOKEN, theme: null, context: {} });
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]?.message).toMatchObject({ type: 'error', fatal: true, error: { code: 'hello_mismatch' } });
    bridge.stop();

    sent = [];
    const noToken = new Bridge({ win, api: fakeApi([PARENT], []) });
    await noToken.start();
    fromParent({ v: 1, type: 'hello', nonce: NONCE, flow: 'wallet', publishableKey: PK, embedToken: null, theme: null, context: {} });
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]?.message).toMatchObject({ type: 'error', fatal: true, error: { code: 'embed_token_required' } });
    noToken.stop();
  });

  it('a bad URL is refused before anything is fetched', async () => {
    const calls: Call[] = [];
    const broken = new Proxy(window, { get: (target, property) => (property === 'location' ? { ...target.location, search: '?flow=admin' } : Reflect.get(target, property)) });
    const bridge = new Bridge({ win: broken, api: fakeApi([PARENT], calls) });
    await bridge.start();
    expect(bridge.current).toEqual({ phase: 'refused', reason: 'bad_url' });
    expect(calls).toEqual([]);
  });
});
