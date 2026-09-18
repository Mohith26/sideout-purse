'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ApiError, EmbedUserState, MountableFlow, VerificationResource } from '@purse/types';

import { Notice } from '../components/ui';
import { Entry } from '../flows/Entry';
import { Identity } from '../flows/Identity';
import { Rewards } from '../flows/Rewards';
import { Signin } from '../flows/Signin';
import { Wallet } from '../flows/Wallet';
import { Bridge, type BridgeStatus } from './bridge';

/**
 * The frame's root. One `Bridge` per page load runs the handshake with the parent (spec
 * 4.8); once it is `ready` the flow named in the URL renders, and the flows report back
 * through the bridge: state changes, sealed errors, completion. A `ResizeObserver` on the
 * document keeps the parent's frame at the content's height (rule 6), so nothing here
 * ever scrolls.
 */
const TITLES: Record<MountableFlow, string> = {
  signin: 'Sign in',
  identity: 'Verify your identity',
  wallet: 'Your wallet',
  entry: 'Confirm your entry',
  rewards: 'Your rewards',
};

export function EmbedApp() {
  // Built once per page load; the prerender has no window and renders the blank frame.
  const [bridge] = useState<Bridge | undefined>(() => (typeof window === 'undefined' ? undefined : new Bridge({ win: window })));
  const [status, setStatus] = useState<BridgeStatus>({ phase: 'starting' });

  useEffect(() => {
    if (bridge === undefined) return;
    const unsubscribe = bridge.subscribe(setStatus);
    void bridge.start();
    const observer = new ResizeObserver(() => bridge.reportHeight());
    observer.observe(document.documentElement);
    return () => {
      observer.disconnect();
      unsubscribe();
      bridge.stop();
    };
  }, [bridge]);

  const onError = useCallback((error: ApiError) => bridge?.report(error), [bridge]);
  const onState = useCallback((state: EmbedUserState) => bridge?.updateState(state), [bridge]);

  if (status.phase === 'starting') return <main className="embed" aria-busy="true" />;
  if (status.phase === 'refused') {
    return (
      <main className="embed">
        <Notice tone="error" title="This page cannot be embedded here">
          {status.reason === 'origin_not_allowed'
            ? `${status.detail ?? 'This origin'} is not on the allowlist for this Purse tenant.`
            : status.reason === 'bad_url'
              ? 'Open it through the Purse SDK.'
              : 'Purse is unreachable; try again shortly.'}
        </Notice>
      </main>
    );
  }
  if (status.phase === 'waiting') return <main className="embed" aria-busy="true" />;
  if (status.phase === 'failed') {
    return (
      <main className="embed">
        <Notice tone="error" title={status.error.type === 'authentication_error' ? 'This link has expired' : 'Something went wrong'}>
          {status.error.message}
        </Notice>
      </main>
    );
  }

  const api = bridge?.api;
  if (bridge === undefined || api === undefined) return null;
  const { flow, state, context } = status;
  const userId = state.authenticated ? state.user.id : '';

  return (
    <main className="embed">
      <header className="embed__head">
        <h1 className="embed__title display">{TITLES[flow]}</h1>
        <span className="muted">Purse</span>
      </header>
      {flow === 'signin' ? (
        <Signin
          api={api}
          state={state}
          onError={onError}
          onSignedIn={(next) => {
            onState(next);
            if (next.authenticated) bridge.complete({ flow: 'signin', userId: next.user.id });
          }}
        />
      ) : null}
      {flow === 'identity' ? (
        <Identity api={api} state={state} onState={onState} onError={onError} onDone={(verification: VerificationResource) => bridge.complete({ flow: 'identity', userId, verification })} />
      ) : null}
      {flow === 'wallet' ? <Wallet state={state} onDone={() => bridge.complete({ flow: 'wallet', userId })} /> : null}
      {flow === 'entry' ? (
        <Entry
          api={api}
          state={state}
          contestId={context.contestId}
          onError={onError}
          onEntered={(entry) => {
            void api.state().then(onState).catch(() => undefined);
            bridge.complete({ flow: 'entry', userId, contestId: entry.contest.id, participantId: entry.participant.id, journalEntryId: entry.journalEntryId });
          }}
        />
      ) : null}
      {flow === 'rewards' ? <Rewards api={api} state={state} onError={onError} onDone={() => bridge.complete({ flow: 'rewards', userId })} /> : null}
    </main>
  );
}
