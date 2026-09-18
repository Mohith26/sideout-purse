'use client';

import { useEffect, useState } from 'react';
import type { ApiError, EmbedUserState } from '@purse/types';

import { toApiError, type EmbedApi, type RewardRow } from '../embed/api';
import { Button, ErrorNotice, Money, Notice } from '../components/ui';

const ORDINAL = new Intl.PluralRules('en', { type: 'ordinal' });
const SUFFIX: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' };
const ordinal = (n: number): string => `${n}${SUFFIX[ORDINAL.select(n)] ?? 'th'}`;

/** The user's settled results (spec 4.8 rewards flow): placement and payout per contest, newest first. */
export function Rewards({ api, state, onDone, onError }: { api: EmbedApi; state: EmbedUserState; onDone: () => void; onError: (error: ApiError) => void }) {
  const [rows, setRows] = useState<RewardRow[] | undefined>();
  const [error, setError] = useState<ApiError | undefined>();

  useEffect(() => {
    if (!state.authenticated) return;
    let cancelled = false;
    api
      .rewards()
      .then((loaded) => {
        if (!cancelled) setRows(loaded.results);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const failure = toApiError(caught);
        setError(failure);
        onError(failure);
      });
    return () => {
      cancelled = true;
    };
  }, [api, state.authenticated, onError]);

  if (!state.authenticated) return <Notice tone="error" title="No session">Open this flow with an embed token or sign in first.</Notice>;

  return (
    <>
      <div className="card">
        {rows === undefined ? (
          error === undefined ? <p className="embed__lede">Loading your results…</p> : null
        ) : rows.length === 0 ? (
          <p className="embed__lede">No settled contests yet. Payouts land here the moment a contest closes.</p>
        ) : (
          <ul className="list">
            {rows.map((row) => (
              <li key={`${row.contestId}`} className="row">
                <span>
                  <span className="row__value">{row.title}</span>
                  <br />
                  <span className="muted">
                    {ordinal(row.placement)} · {new Date(row.computedAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="row__value">
                  <Money amount={row.payoutAmount} asset={row.asset} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error === undefined ? null : <ErrorNotice error={error} />}
      <div className="actions">
        <Button onClick={onDone}>Done</Button>
      </div>
    </>
  );
}
