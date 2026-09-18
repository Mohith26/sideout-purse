'use client';

import { useEffect, useState } from 'react';
import type { ApiError, ContestResource, EmbedUserState, EntryResource, PrizeStructure } from '@purse/types';

import { toApiError, type EmbedApi } from '../embed/api';
import { Button, ErrorNotice, Money, Notice } from '../components/ui';

/**
 * Entry confirm (spec 4.8): the contest summary, the stake against the wallet, and one
 * confirm. A refusal renders the sealed eligibility variants (spec 4.5) with the required
 * action; the parent gets the same error to branch on.
 */
function describePrizes(structure: PrizeStructure): string {
  switch (structure.type) {
    case 'winner_take_all':
      return 'Winner takes all';
    case 'percentage_split':
      return `Split ${structure.percentages.map((percent) => `${percent}%`).join(' / ')}`;
    case 'top_n_equal':
      return `Top ${structure.n} share equally`;
    case 'placement_table':
      return `${structure.placements.length} paid places`;
    case 'guaranteed_minimum':
      return `Guaranteed minimums, then ${structure.percentages.map((percent) => `${percent}%`).join(' / ')}`;
  }
}

export function Entry({ api, state, contestId, onEntered, onError }: { api: EmbedApi; state: EmbedUserState; contestId: string | undefined; onEntered: (entry: EntryResource) => void; onError: (error: ApiError) => void }) {
  const [contest, setContest] = useState<ContestResource | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);
  const [entered, setEntered] = useState<EntryResource | undefined>();

  useEffect(() => {
    if (contestId === undefined || !state.authenticated) return;
    let cancelled = false;
    api
      .contest(contestId)
      .then((loaded) => {
        if (!cancelled) setContest(loaded);
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
  }, [api, contestId, state.authenticated, onError]);

  if (!state.authenticated) return <Notice tone="error" title="No session">Open this flow with an embed token or sign in first.</Notice>;
  if (contestId === undefined) return <Notice tone="error" title="No contest">This flow was opened without a contest to confirm.</Notice>;

  const balance = contest === undefined ? undefined : (state.user.wallet.find((each) => each.asset === contest.asset)?.balance ?? '0');

  const confirm = async (): Promise<void> => {
    if (contest === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.enter(contest.id);
      setEntered(result);
      onEntered(result);
    } catch (caught) {
      const failure = toApiError(caught);
      setError(failure);
      onError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      {contest === undefined ? (
        error === undefined ? (
          <p className="embed__lede">Loading the contest…</p>
        ) : null
      ) : (
        <>
          <div className="stat">
            <span className="label">{contest.kind.replace('_', ' ')}</span>
            <span className="embed__title display">{contest.title}</span>
          </div>
          <div className="row">
            <span className="row__label">Entry</span>
            <span className="row__value">
              <Money amount={contest.entryAmount} asset={contest.asset} />
            </span>
          </div>
          <div className="row">
            <span className="row__label">Your balance</span>
            <span className="row__value">{balance === undefined ? '—' : <Money amount={balance} asset={contest.asset} />}</span>
          </div>
          <div className="row">
            <span className="row__label">Entrants</span>
            <span className="row__value tabular">{contest.maxParticipants === null ? contest.participantCount : `${contest.participantCount} of ${contest.maxParticipants}`}</span>
          </div>
          <div className="row">
            <span className="row__label">Prizes</span>
            <span className="row__value">{describePrizes(contest.prizeStructure)}</span>
          </div>
          <div className="row">
            <span className="row__label">Status</span>
            <span className={`chip${contest.state === 'open' ? ' chip--live' : ''}`}>{contest.state.replace('_', ' ')}</span>
          </div>
        </>
      )}
      {entered === undefined ? null : (
        <Notice tone="positive" title="You are in">
          Your stake of <Money amount={contest?.entryAmount ?? '0'} asset={contest?.asset ?? ''} /> is held in escrow until the contest settles.
        </Notice>
      )}
      {error === undefined ? null : <ErrorNotice error={error} />}
      <div className="actions">
        {entered === undefined ? (
          <Button onClick={() => void confirm()} disabled={busy || contest?.state !== 'open'}>
            Confirm entry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
