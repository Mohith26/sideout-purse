// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EmbedError, FlowResult, MountableFlow } from '@purse/types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PurseGate, usePurse, type PurseLike } from '../../src/components/purse/PurseGate';
import { VerificationRow } from '../../src/components/purse/VerificationRow';
import { WalletChip } from '../../src/components/purse/WalletChip';
import { interact } from './act';

/**
 * `PurseGate` with a stand-in SDK: it links the account, mints an embed token, mounts the
 * flow, and maps the sealed outcomes to UI states; `VerificationRow` and `WalletChip`
 * render what the gate holds, including the terminal row with a support path and no
 * retry.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const CONFIG = { publishableKey: `pk_sandbox_${'a'.repeat(32)}`, tenantId: 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9', purseOrigin: 'http://purse.test' };
const LINKS = { supportHref: 'http://purse.test/support', policyHref: 'http://purse.test/responsible-play', selfLimitHref: 'http://purse.test/responsible-play#limits' };

type Profile = { linked: boolean; verification: { state: string; provider: null; verifiedAt: null; reverifyAfter: null } | null; restrictions: Array<{ kind: string }>; wallet: Array<{ asset: string; balance: string; accountId: null }>; displayName: string | null };

const unverified: Profile = { linked: true, verification: { state: 'unstarted', provider: null, verifiedAt: null, reverifyAfter: null }, restrictions: [], wallet: [{ asset: 'POINTS', balance: '900', accountId: null }], displayName: 'Leila' };

/** A fetch stand-in for the three routes the gate talks to. */
function fakeApi(profile: Profile, options: { linkFails?: { type: string; code: string; message: string; detail?: unknown } } = {}) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { flow?: string }) : null;
    calls.push({ path, body });
    const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
    if (path === '/api/me/purse') return json({ data: profile });
    if (path === '/api/me/purse/link') return options.linkFails === undefined ? json({ data: profile }) : json({ error: options.linkFails }, 409);
    if (path === '/api/me/purse/embed-token') return json({ data: { token: 'emb_1', contestId: body?.flow === 'entry' ? 'cnt_1' : null, ...CONFIG } });
    return json({ error: { type: 'invalid_request', code: 'unknown', message: `no route ${path}` } }, 404);
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { calls, fetchImpl };
}

/** A stand-in SDK: records the mount and lets the test fire `flow:complete` or `error`. */
function fakeSdk() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const mounted: Array<{ flow: MountableFlow; embedToken?: string; contestId?: string }> = [];
  const sdk: PurseLike = {
    mount: (_slot, options) => {
      mounted.push({ flow: options.flow, ...(options.embedToken === undefined ? {} : { embedToken: options.embedToken }), ...(options.contestId === undefined ? {} : { contestId: options.contestId }) });
      return Promise.resolve({});
    },
    unmount: vi.fn(),
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as (payload: unknown) => void]);
      return () => undefined;
    },
  };
  const emit = (event: 'flow:complete' | 'error', payload: FlowResult | EmbedError) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  return { sdk, mounted, emit, init: vi.fn(() => Promise.resolve(sdk)) };
}

function Launcher({ flow }: { flow: MountableFlow }) {
  const purse = usePurse();
  return (
    <div>
      <button type="button" onClick={() => void purse.open(flow)}>
        open {flow}
      </button>
      <output data-testid="status">{purse.profile.kind}</output>
      <output data-testid="failure">{purse.failure?.kind ?? 'none'}</output>
    </div>
  );
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(cleanup);

describe('PurseGate', () => {
  it('reads the profile eagerly and renders the wallet and the identity row from it', async () => {
    fakeApi(unverified);
    render(
      <PurseGate config={CONFIG} signedIn eager>
        <VerificationRow supportHref={LINKS.supportHref} />
        <WalletChip {...LINKS} />
      </PurseGate>,
    );
    await waitFor(() => expect(screen.getByTestId('wallet-balance').textContent).toContain('900 POINTS'));
    expect(screen.getByTestId('verification-row').dataset['state']).toBe('unstarted');
    expect(screen.getByRole('button', { name: 'Verify with Purse' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wallet' })).toBeTruthy();
  });

  it('says so when the server has no Purse configuration, and offers no flow', async () => {
    fakeApi(unverified);
    render(
      <PurseGate config={null} signedIn>
        <VerificationRow supportHref={LINKS.supportHref} />
        <WalletChip {...LINKS} />
      </PurseGate>,
    );
    expect(screen.getByTestId('wallet-chip').dataset['state']).toBe('unconfigured');
    expect(screen.queryByRole('button', { name: 'Verify with Purse' })).toBeNull();
    expect(screen.getByText('Purse is not configured on this server')).toBeTruthy();
    await Promise.resolve();
  });

  it('opens a flow: links, mints a token for that flow, mounts it in the sheet, and re-reads the profile on completion', async () => {
    const api = fakeApi(unverified);
    const fake = fakeSdk();
    render(
      <PurseGate config={CONFIG} signedIn init={fake.init}>
        <Launcher flow="identity" />
      </PurseGate>,
    );
    await interact(() => fireEvent.click(screen.getByRole('button', { name: 'open identity' })));
    await waitFor(() => expect(fake.mounted).toHaveLength(1));
    expect(api.calls.map((c) => c.path)).toEqual(['/api/me/purse/link', '/api/me/purse/embed-token']);
    expect(api.calls[1]?.body).toEqual({ flow: 'identity' });
    expect(fake.init).toHaveBeenCalledWith(CONFIG);
    expect(fake.mounted[0]).toEqual({ flow: 'identity', embedToken: 'emb_1' });
    expect(screen.getByTestId('purse-sheet').getAttribute('data-closing')).toBeNull();
    await interact(() => fake.emit('flow:complete', { flow: 'identity', userId: 'usr_1', verification: { state: 'verified', provider: 'dev', verifiedAt: null, reverifyAfter: null } }));
    await waitFor(() => expect(api.calls.map((c) => c.path)).toContain('/api/me/purse'));
  });

  it('passes the contest to an entry flow', async () => {
    const api = fakeApi(unverified);
    const fake = fakeSdk();
    render(
      <PurseGate config={CONFIG} signedIn init={fake.init}>
        <Launcher flow="entry" />
      </PurseGate>,
    );
    await interact(() => fireEvent.click(screen.getByRole('button', { name: 'open entry' })));
    await waitFor(() => expect(fake.mounted).toHaveLength(1));
    expect(api.calls[1]?.body).toEqual({ flow: 'entry' });
    expect(fake.mounted[0]).toEqual({ flow: 'entry', embedToken: 'emb_1', contestId: 'cnt_1' });
  });

  it('maps a sealed error from the frame to a UI state and shows it in the sheet', async () => {
    fakeApi(unverified);
    const fake = fakeSdk();
    render(
      <PurseGate config={CONFIG} signedIn init={fake.init}>
        <Launcher flow="entry" />
      </PurseGate>,
    );
    await interact(() => fireEvent.click(screen.getByRole('button', { name: 'open entry' })));
    await waitFor(() => expect(fake.mounted).toHaveLength(1));
    await interact(() => fake.emit('error', { type: 'not_eligible', code: 'not_eligible', message: 'refused', detail: { reasons: ['identity_unverified'], requiredAction: 'complete_identity', rulesetVersion: '1' } }));
    expect(screen.getByTestId('failure').textContent).toBe('action');
    expect(screen.getByTestId('purse-sheet-failure').textContent).toContain('Verify your identity first');
  });

  it('a link the platform refuses as terminal lands on the verification row as a terminal state with a support path and no retry', async () => {
    fakeApi({ ...unverified, linked: false, verification: null, wallet: [] }, { linkFails: { type: 'invalid_state', code: 'not_eligible', message: 'blocked', detail: { purse: { type: 'not_eligible', code: 'not_eligible', message: 'blocked', detail: { reasons: ['platform_blocked'], rulesetVersion: '1' } } } } });
    const fake = fakeSdk();
    render(
      <PurseGate config={CONFIG} signedIn init={fake.init}>
        <Launcher flow="identity" />
        <WalletChip {...LINKS} />
      </PurseGate>,
    );
    await interact(() => fireEvent.click(screen.getByRole('button', { name: 'open identity' })));
    await waitFor(() => expect(screen.getByTestId('failure').textContent).toBe('terminal'));
    expect(fake.mounted).toHaveLength(0);
    const notice = screen.getByTestId('purse-notice-terminal');
    expect(notice.textContent).toContain('Purse has restricted this account');
    expect(notice.querySelector('a[href="http://purse.test/support"]')).not.toBeNull();
    expect(notice.textContent).not.toContain('Try again');
  });

  it('renders a rejected verification as the calm terminal row', async () => {
    fakeApi({ ...unverified, verification: { state: 'rejected', provider: null, verifiedAt: null, reverifyAfter: null } });
    render(
      <PurseGate config={CONFIG} signedIn eager>
        <VerificationRow supportHref={LINKS.supportHref} />
      </PurseGate>,
    );
    await waitFor(() => expect(screen.getByTestId('verification-row').dataset['state']).toBe('rejected'));
    expect(screen.getByText('Purse could not verify this account')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Contact Purse support/ }).getAttribute('href')).toBe(LINKS.supportHref);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
