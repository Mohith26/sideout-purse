'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Purse, type PurseEvents } from '@purse/sdk';
import type { ApiError, FlowResult, MountableFlow, RestrictionResource, VerificationResource, WalletBalanceResource } from '@purse/types';
import { Sheet } from '@sideout/ui';

import { api } from '../../lib/api-client';
import { mapPurseError, type PurseErrorLike, type PurseUiState } from './eligibility';

/**
 * `PurseGate` (spec 4.8, 5.3): the single component that mounts `@purse/sdk` flows in the
 * browser. Nothing else imports the SDK; ESLint refuses it
 * (`packages/config/eslint/boundary.js`) and `test/purse/sdk-gate.test.ts` proves it.
 * Everything else calls `usePurse()`.
 *
 * A flow runs on the Purse origin, in Purse's iframe: the gate links the player's Purse
 * account (`POST /api/me/purse/link`, an upsert by the opaque external id), mints a
 * single-use embed token server to server (`POST /api/me/purse/embed-token`), initialises
 * the SDK with the publishable key and the tenant from the server's public config, mounts
 * the flow into a slot (a bottom sheet by default, or a slot a screen registers, as the
 * registration step does so the entry sits on its own visibly distinct surface), and maps
 * every sealed error to a UI state through `mapPurseError`. The profile it holds is what
 * Purse said last (`GET /api/me/purse`): verification, restrictions and the wallet, read
 * live and never stored.
 */
export type PurseConfig = { publishableKey: string; tenantId: string; purseOrigin: string };

export type PurseProfileView = {
  linked: boolean;
  verification: VerificationResource | null;
  restrictions: RestrictionResource[];
  wallet: WalletBalanceResource[];
  displayName: string | null;
};

export type ProfileState = { kind: 'unknown' } | { kind: 'loading' } | { kind: 'ready'; profile: PurseProfileView } | { kind: 'unavailable'; failure: PurseUiState };

export type FlowOutcome = { ok: true; flow: MountableFlow; result: FlowResult | null } | { ok: false; flow: MountableFlow; failure: PurseUiState };

export type OpenOptions = { tournamentSlug?: string; title?: string };

export type PurseContextValue = {
  /** Null when the server has no publishable key: nothing can mount and the UI says so. */
  config: PurseConfig | null;
  signedIn: boolean;
  profile: ProfileState;
  /** A flow is on screen or a request is in flight. */
  busy: boolean;
  /** The last failure a flow produced, mapped; null after a success or `dismissFailure()`. */
  failure: PurseUiState | null;
  /** The flow currently mounted, if any. */
  activeFlow: MountableFlow | null;
  refreshProfile: () => Promise<void>;
  /** Link (upsert) the player's Purse account and read the profile back. */
  link: () => Promise<boolean>;
  /** Run a flow to completion, or until the person closes it. */
  open: (flow: MountableFlow, options?: OpenOptions) => Promise<FlowOutcome>;
  /** A screen may host the frame itself instead of the sheet: register an element while mounted. */
  registerSlot: (element: HTMLElement | null) => void;
  dismissFailure: () => void;
};

const PurseContext = createContext<PurseContextValue | null>(null);

/** Read the gate. Throws outside a `PurseGate`, which is a programming error, not a state. */
export function usePurse(): PurseContextValue {
  const value = useContext(PurseContext);
  if (value === null) throw new Error('usePurse() must be used inside <PurseGate>');
  return value;
}

/** Whether a `PurseGate` is above; components that can render without one check this first. */
export function usePurseOptional(): PurseContextValue | null {
  return useContext(PurseContext);
}

type Grant = { token: string; contestId: string | null; purseOrigin: string; publishableKey: string; tenantId: string };

const FLOW_TITLE: Record<MountableFlow, string> = { signin: 'Sign in to Purse', identity: 'Verify with Purse', wallet: 'Your Purse wallet', entry: 'Enter the contest on Purse', rewards: 'Your rewards on Purse' };

/** The theme the frame renders with, so a Purse flow looks native inside Sideout (spec 4.8 rule 8). */
export const PURSE_THEME = { accent: '#D7FF3E', surface: '#101216', radius: 10, font: 'Instrument Sans' } as const;

const UNAVAILABLE: PurseUiState = { kind: 'unavailable', title: 'Purse is not configured', body: 'This server has no Purse publishable key, so Purse flows cannot open here.' };
const NOT_SIGNED_IN: PurseUiState = { kind: 'retry', reasons: [], title: 'Sign in first', body: 'Purse flows belong to your Sideout account. Sign in and try again.' };

function failureOf(error: PurseErrorLike): PurseUiState {
  return mapPurseError(error);
}

export type PurseGateProps = {
  config: PurseConfig | null;
  signedIn: boolean;
  /** Read the profile on mount (the profile page); the registration step reads it when it opens a flow. */
  eager?: boolean;
  children: ReactNode;
  /** Test hook: the SDK factory, so a test can hand in a stand-in that never opens an iframe. */
  init?: (options: { publishableKey: string; tenantId: string; purseOrigin: string }) => Promise<PurseLike>;
};

/** The slice of `Purse` the gate uses, so a test can stand in for it. */
export type PurseLike = {
  mount: (slot: Element, options: { flow: MountableFlow; embedToken?: string; contestId?: string; initialHeight?: number }) => Promise<unknown>;
  unmount: () => void;
  on: <E extends keyof PurseEvents>(event: E, handler: (payload: PurseEvents[E]) => void) => () => void;
};

async function initSdk(options: { publishableKey: string; tenantId: string; purseOrigin: string }): Promise<PurseLike> {
  return Purse.init({ ...options, theme: { ...PURSE_THEME } });
}

export function PurseGate({ config, signedIn, eager = false, children, init = initSdk }: PurseGateProps) {
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileState>({ kind: 'unknown' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PurseUiState | null>(null);
  const [active, setActive] = useState<{ flow: MountableFlow; title: string } | null>(null);
  const [frameHeight, setFrameHeight] = useState(420);
  const sheetSlot = useRef<HTMLDivElement>(null);
  const hostedSlot = useRef<HTMLElement | null>(null);
  const purseRef = useRef<PurseLike | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  const refreshProfile = useCallback(async () => {
    if (!signedIn) return;
    setProfile((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
    const result = await api<PurseProfileView>('/api/me/purse');
    if (result.ok) setProfile({ kind: 'ready', profile: result.data });
    else setProfile({ kind: 'unavailable', failure: result.error.code === 'purse_unavailable' ? UNAVAILABLE : failureOf(result.error) });
  }, [signedIn]);

  useEffect(() => {
    if (!eager || !signedIn) return;
    queueMicrotask(() => {
      void refreshProfile();
    });
  }, [eager, signedIn, refreshProfile]);

  const link = useCallback(async (): Promise<boolean> => {
    if (!signedIn) {
      setFailure(NOT_SIGNED_IN);
      return false;
    }
    const result = await api<PurseProfileView>('/api/me/purse/link', { method: 'POST', body: {} });
    if (!result.ok) {
      const mapped = result.error.code === 'purse_unavailable' ? UNAVAILABLE : failureOf(result.error);
      setFailure(mapped);
      setProfile({ kind: 'unavailable', failure: mapped });
      return false;
    }
    setProfile({ kind: 'ready', profile: result.data });
    return true;
  }, [signedIn]);

  const registerSlot = useCallback((element: HTMLElement | null) => {
    hostedSlot.current = element;
  }, []);

  const teardown = useCallback(() => {
    purseRef.current?.unmount();
    purseRef.current = null;
    closeRef.current = null;
    setActive(null);
  }, []);

  useEffect(() => () => purseRef.current?.unmount(), []);

  const open = useCallback(
    async (flow: MountableFlow, options: OpenOptions = {}): Promise<FlowOutcome> => {
      if (config === null) {
        setFailure(UNAVAILABLE);
        return { ok: false, flow, failure: UNAVAILABLE };
      }
      if (!signedIn) {
        setFailure(NOT_SIGNED_IN);
        return { ok: false, flow, failure: NOT_SIGNED_IN };
      }
      setBusy(true);
      setFailure(null);
      try {
        // The link is an upsert: harmless when it exists, and the welcome grant is keyed once.
        const linked = profile.kind === 'ready' && profile.profile.linked ? true : await link();
        if (!linked) return { ok: false, flow, failure: failure ?? UNAVAILABLE };
        if (flow === 'signin') return { ok: false, flow, failure: { kind: 'unavailable', title: 'Not needed', body: 'Purse sessions open from an embed token minted for your account; there is no separate sign-in.' } };
        const minted = await api<Grant>('/api/me/purse/embed-token', { method: 'POST', body: { flow, ...(options.tournamentSlug === undefined ? {} : { tournamentSlug: options.tournamentSlug }) } });
        if (!minted.ok) {
          const mapped = minted.error.code === 'purse_unavailable' ? UNAVAILABLE : failureOf(minted.error);
          setFailure(mapped);
          return { ok: false, flow, failure: mapped };
        }
        const grant = minted.data;
        if (flow === 'entry' && grant.contestId === null) {
          const mapped: PurseUiState = { kind: 'retry', reasons: [], title: 'No contest to enter', body: 'The event has no Purse contest yet. Ask the organizer to open registration again.' };
          setFailure(mapped);
          return { ok: false, flow, failure: mapped };
        }
        const purse = await init({ publishableKey: grant.publishableKey, tenantId: grant.tenantId, purseOrigin: grant.purseOrigin });
        purseRef.current?.unmount();
        purseRef.current = purse;
        const hosted = hostedSlot.current;
        if (hosted === null) setActive({ flow, title: options.title ?? FLOW_TITLE[flow] });
        // The sheet mounts on the next paint; wait for its slot before mounting into it.
        const slot = hosted ?? (await waitFor(() => sheetSlot.current));
        if (slot === null) throw new Error('The Purse slot is missing.');
        const outcome = await new Promise<FlowOutcome>((resolve) => {
          let settled = false;
          const finish = (value: FlowOutcome) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          purse.on('flow:complete', (result: PurseEvents['flow:complete']) => finish({ ok: true, flow, result }));
          purse.on('error', (error: PurseEvents['error']) => {
            const mapped = failureOf(error);
            setFailure(mapped);
            // A frame that could not start is over; an eligibility refusal stays on screen for the person to read.
            if (error.type === 'internal_error' || error.type === 'authentication_error') finish({ ok: false, flow, failure: mapped });
          });
          purse.on('resize', ({ height }: PurseEvents['resize']) => setFrameHeight(Math.max(240, Math.min(900, height))));
          closeRef.current = () => finish({ ok: true, flow, result: null });
          void purse.mount(slot, { flow, embedToken: grant.token, ...(grant.contestId === null ? {} : { contestId: grant.contestId }), initialHeight: 420 }).catch((caught: unknown) => {
            const error: ApiError = isApiError(caught) ? caught : { type: 'internal_error', code: 'mount_failed', message: caught instanceof Error ? caught.message : String(caught) };
            const mapped = failureOf(error);
            setFailure(mapped);
            finish({ ok: false, flow, failure: mapped });
          });
        });
        // A completed flow stays on screen until the person closes it (the frame shows its own
        // outcome); the profile and the page re-read what changed meanwhile.
        if (outcome.ok && outcome.result !== null) {
          await refreshProfile();
          router.refresh();
        }
        return outcome;
      } catch (caught) {
        const mapped: PurseUiState = { kind: 'unavailable', title: 'Purse did not answer', body: caught instanceof Error ? caught.message : 'The Purse frame could not open.' };
        setFailure(mapped);
        return { ok: false, flow, failure: mapped };
      } finally {
        setBusy(false);
        if (hostedSlot.current !== null) teardown();
      }
    },
    [config, signedIn, profile, link, failure, init, refreshProfile, router, teardown],
  );

  const dismissFailure = useCallback(() => setFailure(null), []);

  const value = useMemo<PurseContextValue>(
    () => ({ config, signedIn, profile, busy, failure, activeFlow: active?.flow ?? null, refreshProfile, link, open, registerSlot, dismissFailure }),
    [config, signedIn, profile, busy, failure, active, refreshProfile, link, open, registerSlot, dismissFailure],
  );

  const onSheetClose = useCallback(() => {
    closeRef.current?.();
    teardown();
  }, [teardown]);

  return (
    <PurseContext.Provider value={value}>
      {children}
      <Sheet open={active !== null} title={active?.title ?? ''} subtitle="Runs on Purse, in Purse’s own frame" onClose={onSheetClose} testId="purse-sheet">
        <div className="rounded-card border border-volt/40 bg-bg-inset p-2" data-testid="purse-slot">
          <div ref={sheetSlot} style={{ minHeight: frameHeight }} aria-live="polite" />
        </div>
        {failure === null ? null : (
          <p role="alert" className="mt-3 text-text-secondary" data-testid="purse-sheet-failure">
            <span className="font-medium text-text-primary">{failure.title}.</span> {failure.body}
          </p>
        )}
      </Sheet>
    </PurseContext.Provider>
  );
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' && typeof (value as { code?: unknown }).code === 'string' && typeof (value as { message?: unknown }).message === 'string';
}

/** Poll for an element React is about to commit, a few frames at most. */
function waitFor(read: () => HTMLElement | null): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      const element = read();
      if (element !== null || tries > 20) {
        resolve(element);
        return;
      }
      tries += 1;
      setTimeout(tick, 16);
    };
    tick();
  });
}
