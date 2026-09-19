'use client';

import { useCallback, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ActionButton, Button, Card, Chip, DataTable, Field, Input, KeyValue, Money, Mono, Notice, Stat, type Column } from '@sideout/ui';

import { api, type ApiError } from '../lib/api-client';
import type { LadderRow, MatchView, SeasonView } from '../server/seasons';
import { PurseFrame, type FrameOutcome } from './PurseFrame';

/**
 * The whole ladder on one screen: the season and its state, the table with a challenge
 * button on each reachable row, the open matches with report / confirm / reject, the
 * commissioner's start and two-step close, and the Purse side of it all (link, the entry
 * flow in Purse's frame, the wallet, the settlement). Every action posts to the API and
 * replaces the season view with what came back.
 */
export type Me = { id: string; name: string };
export type Profile = { linked: boolean; configured: boolean; wallet: Array<{ asset: string; balance: string }> };

type ClosePreview = { payoutHash: string; escrowTotal: string; payouts: Array<{ userId: string; placement: number; payout: string }>; standings: Array<{ playerId: string; purseUserId: string; rank: number; score: number }> };

type Props = { me: Me; season: SeasonView | null; profile: Profile };

const STATUS_LABEL: Record<SeasonView['status'], string> = { enrolling: 'Enrolling', playing: 'Playing', closing: 'Closing', closed: 'Closed' };

export function LadderScreen({ me, season: initialSeason, profile: initialProfile }: Props) {
  const [season, setSeason] = useState<SeasonView | null>(initialSeason);
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  // Flipped once the component is interactive, so the e2e never submits a form the server rendered but React has not yet taken over.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);

  const run = useCallback(async <T,>(path: string, body: unknown, after?: (data: T) => void): Promise<T | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await api<T>(path, { body: body ?? {} });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    const data = result.data;
    if (typeof data === 'object' && data !== null && 'season' in data) setSeason((data as { season: SeasonView }).season);
    after?.(data);
    return data;
  }, []);

  const refreshProfile = useCallback(async () => {
    const result = await api<Profile>('/api/me/purse');
    if (result.ok) setProfile(result.data);
  }, []);

  const link = () => run<Profile>('/api/me/purse/link', {}, (linked) => setProfile({ ...linked, configured: true }));

  const onEntryDone = async (outcome: FrameOutcome) => {
    setEntering(false);
    if (!outcome.ok) {
      setError({ type: 'internal_error', code: outcome.code, message: outcome.message });
      return;
    }
    if (season === null) return;
    await run<{ added: number }>(`/api/seasons/${season.id}/entries/sync`, {}, ({ added }) => setNotice(added > 0 ? 'You are on the ladder.' : 'Purse already held your entry.'));
    await refreshProfile();
  };

  const points = profile.wallet.find((b) => b.asset === 'POINTS')?.balance ?? null;

  return (
    <div className="flex flex-col gap-6 py-6" data-testid="ladder-screen" data-hydrated={hydrated ? 'true' : 'false'}>
      {error === null ? null : (
        <Notice tone="error" title={error.code}>
          {error.message}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="positive" title="Done">
          {notice}
        </Notice>
      )}

      <section aria-labelledby="purse-heading">
        <Card
          title={<span id="purse-heading">Your Purse account</span>}
          actions={
            !profile.configured ? (
              <Chip tone="neutral">Purse not configured</Chip>
            ) : profile.linked ? (
              <Chip tone="surf">Linked</Chip>
            ) : (
              <ActionButton variant="secondary" onClick={() => void link()} disabled={busy} data-testid="link-purse">
                Link Purse
              </ActionButton>
            )
          }
        >
          {profile.linked ? (
            <div className="flex flex-wrap gap-6">
              <Stat label="POINTS balance" value={points === null ? '—' : <Money amount={points} asset="POINTS" />} />
              <p className="type-body max-w-md text-text-secondary">Your stake, the eligibility check and the payout live in Purse; the ladder only ever sees the contest by its id.</p>
            </div>
          ) : (
            <p className="type-body text-text-secondary">Linking creates your Purse user under an opaque id and grants the welcome points a season entry costs.</p>
          )}
        </Card>
      </section>

      {season === null ? (
        <OpenSeason busy={busy} onOpen={(title) => void run('/api/seasons', { title })} />
      ) : (
        <>
          <SeasonHeader season={season} me={me} busy={busy} entering={entering} linked={profile.linked} onEnter={() => setEntering(true)} onStart={() => void run(`/api/seasons/${season.id}/start`, {})} onSync={() => void run(`/api/seasons/${season.id}/entries/sync`, {})} />
          {entering ? <PurseFrame flow="entry" seasonId={season.id} onDone={(outcome) => void onEntryDone(outcome)} /> : null}
          <Ladder season={season} busy={busy} onChallenge={(defenderId) => void run(`/api/seasons/${season.id}/challenges`, { defenderId })} />
          <Matches season={season} busy={busy} run={run} />
          {season.youAreCommissioner && (season.status === 'playing' || season.status === 'closing') ? (
            <CloseFlow season={season} busy={busy} preview={preview} onPreview={() => void run<ClosePreview>(`/api/seasons/${season.id}/close/preview`, {}, setPreview)} onClose={(hash) => void run(`/api/seasons/${season.id}/close`, { payoutHash: hash }, () => void refreshProfile())} />
          ) : null}
          {season.status === 'closed' && season.settlement !== null ? <Settled season={season} /> : null}
          {season.status === 'closed' ? <OpenSeason busy={busy} onOpen={(title) => void run('/api/seasons', { title })} /> : null}
        </>
      )}
    </div>
  );
}

function OpenSeason({ busy, onOpen }: { busy: boolean; onOpen: (title: string) => void }) {
  const [title, setTitle] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onOpen(title);
  };
  return (
    <Card title="Open the next season">
      <form onSubmit={submit} className="flex flex-col gap-4 sm:flex-row sm:items-end" data-testid="open-season-form">
        <div className="grow">
          <Field id="season-title" label="Season title">
            <Input id="season-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={60} placeholder="Autumn 2026" />
          </Field>
        </div>
        <ActionButton variant="primary" type="submit" disabled={busy}>
          Open season
        </ActionButton>
      </form>
      <p className="type-label mt-3 text-text-secondary">Whoever opens the season is its commissioner: they start play and close it. One Purse contest is created for it, with the stake and the 50 / 30 / 20 split.</p>
    </Card>
  );
}

function SeasonHeader({ season, me, busy, entering, linked, onEnter, onStart, onSync }: { season: SeasonView; me: Me; busy: boolean; entering: boolean; linked: boolean; onEnter: () => void; onStart: () => void; onSync: () => void }) {
  return (
    <section aria-labelledby="season-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="season-heading" className="type-display-l" data-testid="season-title">
          {season.title}
        </h1>
        <Chip tone={season.status === 'playing' ? 'surf' : 'neutral'} title={`Purse contest ${season.purse.contestState ?? 'not created yet'}`}>
          {STATUS_LABEL[season.status]}
        </Chip>
      </div>
      <p className="type-body text-text-secondary">
        Commissioner {season.commissioner.id === me.id ? 'you' : season.commissioner.name}. Entry {season.entryPoints} POINTS, held in escrow on Purse until the close. Challenge up to {season.challengeReach} places up.
      </p>
      <div className="flex flex-wrap gap-2">
        {season.status === 'enrolling' && !season.youAreIn ? (
          <ActionButton variant="primary" onClick={onEnter} disabled={busy || entering || !linked} data-testid="enter-season">
            {linked ? 'Enter the season on Purse' : 'Link Purse to enter'}
          </ActionButton>
        ) : null}
        {season.status === 'enrolling' ? (
          <Button onClick={onSync} disabled={busy} data-testid="sync-entries">
            Refresh entrants from Purse
          </Button>
        ) : null}
        {season.status === 'enrolling' && season.youAreCommissioner ? (
          <ActionButton variant="secondary" onClick={onStart} disabled={busy || season.ladder.length < 2} data-testid="start-season">
            Start the season
          </ActionButton>
        ) : null}
      </div>
    </section>
  );
}

function Ladder({ season, busy, onChallenge }: { season: SeasonView; busy: boolean; onChallenge: (defenderId: string) => void }) {
  const columns: Array<Column<LadderRow>> = [
    { key: 'rank', header: '#', numeric: true, render: (row) => row.rank },
    { key: 'player', header: 'Player', render: (row) => (row.you ? <strong>{row.player.name} (you)</strong> : row.player.name) },
    { key: 'record', header: 'W–L', numeric: true, render: (row) => `${row.wins}–${row.losses}` },
    {
      key: 'action',
      header: '',
      render: (row) =>
        row.challengeable ? (
          <Button small onClick={() => onChallenge(row.player.id)} disabled={busy} data-testid={`challenge-${row.player.id}`}>
            Challenge
          </Button>
        ) : null,
    },
  ];
  return (
    <section aria-labelledby="ladder-heading">
      <h2 id="ladder-heading" className="type-heading mb-2">
        Ladder
      </h2>
      <div data-testid="ladder">
        <DataTable columns={columns} rows={season.ladder} rowKey={(row) => row.player.id} empty="Nobody has entered yet." caption="The ladder, top first" />
      </div>
    </section>
  );
}

function Matches({ season, busy, run }: { season: SeasonView; busy: boolean; run: <T>(path: string, body: unknown, after?: (data: T) => void) => Promise<T | null> }) {
  const open = season.matches.filter((m) => m.status === 'challenged' || m.status === 'reported');
  const done = season.matches.filter((m) => m.status === 'confirmed' || m.status === 'declined').slice(0, 10);
  return (
    <section aria-labelledby="matches-heading" className="flex flex-col gap-3">
      <h2 id="matches-heading" className="type-heading">
        Matches
      </h2>
      {open.length === 0 ? <p className="type-body text-text-secondary">No open challenges.</p> : open.map((m) => <OpenMatch key={m.id} match={m} busy={busy} run={run} />)}
      {done.length === 0 ? null : (
        <ul className="flex flex-col gap-1" data-testid="match-history">
          {done.map((m) => (
            <li key={m.id} className="type-body" data-testid={`match-${m.id}`}>
              {m.status === 'declined' ? (
                <>
                  {m.defender.name} declined {m.challenger.name}
                </>
              ) : (
                <>
                  {m.challenger.name} {m.challengerScore}–{m.defenderScore} {m.defender.name} · {m.winner?.name} won{m.ladderMoved ? ' and moved up' : ''}{' '}
                  {m.purse.pushed ? (
                    <Chip tone="surf">pushed to Purse</Chip>
                  ) : m.purse.error === null ? null : (
                    <>
                      {' '}
                      <Chip tone="ember" title={m.purse.error.message}>
                        push failed
                      </Chip>{' '}
                      <Button small disabled={busy} onClick={() => void run(`/api/matches/${m.id}/push`, {})}>
                        Retry
                      </Button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OpenMatch({ match, busy, run }: { match: MatchView; busy: boolean; run: <T>(path: string, body: unknown, after?: (data: T) => void) => Promise<T | null> }) {
  const [challengerScore, setChallengerScore] = useState('11');
  const [defenderScore, setDefenderScore] = useState('');
  const report = (event: FormEvent) => {
    event.preventDefault();
    void run(`/api/matches/${match.id}/report`, { challengerScore: Number(challengerScore), defenderScore: Number(defenderScore) });
  };
  return (
    <Card title={`${match.challenger.name} challenges ${match.defender.name}`} actions={<Chip tone={match.status === 'reported' ? 'ember' : 'neutral'}>{match.status}</Chip>}>
      <div data-testid={`open-match-${match.id}`} className="flex flex-col gap-3">
        {match.status === 'reported' ? (
          <p className="type-body">
            {match.reportedBy?.name} reported {match.challenger.name} {match.challengerScore}–{match.defenderScore} {match.defender.name}.
          </p>
        ) : null}
        {match.yourTurn === 'report' ? (
          <form onSubmit={report} className="flex flex-wrap items-end gap-3" data-testid="report-form">
            <Field id={`c-${match.id}`} label={match.challenger.name}>
              <Input id={`c-${match.id}`} inputMode="numeric" value={challengerScore} onChange={(event) => setChallengerScore(event.target.value)} required />
            </Field>
            <Field id={`d-${match.id}`} label={match.defender.name}>
              <Input id={`d-${match.id}`} inputMode="numeric" value={defenderScore} onChange={(event) => setDefenderScore(event.target.value)} required />
            </Field>
            <ActionButton variant="primary" type="submit" disabled={busy}>
              Report result
            </ActionButton>
            {match.defender.id !== match.challenger.id && match.yourTurn === 'report' ? (
              <Button onClick={() => void run(`/api/matches/${match.id}/decline`, {})} disabled={busy}>
                Decline
              </Button>
            ) : null}
          </form>
        ) : null}
        {match.yourTurn === 'confirm' ? (
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="primary" onClick={() => void run(`/api/matches/${match.id}/confirm`, {})} disabled={busy} data-testid="confirm-result">
              Confirm
            </ActionButton>
            <Button onClick={() => void run(`/api/matches/${match.id}/reject`, {})} disabled={busy}>
              That is not the score
            </Button>
          </div>
        ) : null}
        {match.yourTurn === 'wait' ? <p className="type-label text-text-secondary">Waiting for the other side to confirm.</p> : null}
      </div>
    </Card>
  );
}

function CloseFlow({ season, busy, preview, onPreview, onClose }: { season: SeasonView; busy: boolean; preview: ClosePreview | null; onPreview: () => void; onClose: (hash: string) => void }) {
  const frozen = preview ?? (season.frozenPreview === null ? null : { payoutHash: season.frozenPreview.payoutHash, escrowTotal: season.frozenPreview.escrowTotal, payouts: season.frozenPreview.payouts, standings: season.frozenPreview.standings });
  const nameOf = new Map(season.ladder.map((row) => [row.player.id, row.player.name]));
  const purseToPlayer = new Map((frozen?.standings ?? []).map((s) => [s.purseUserId, s.playerId]));
  return (
    <section aria-labelledby="close-heading">
      <Card title={<span id="close-heading">Close the season</span>}>
        <div className="flex flex-col gap-3" data-testid="close-flow">
          <p className="type-body text-text-secondary">Step 1 pushes every player&apos;s final score and freezes Purse&apos;s settlement preview with its hash. Step 2 confirms that exact hash; Purse recomputes and refuses anything else. Nothing is played once the preview is taken.</p>
          <div>
            <ActionButton variant="secondary" onClick={onPreview} disabled={busy} data-testid="preview-close">
              {frozen === null ? 'Preview the close' : 'Preview again'}
            </ActionButton>
          </div>
          {frozen === null ? null : (
            <div className="flex flex-col gap-3" data-testid="frozen-preview">
              <KeyValue
                items={[
                  { key: 'Escrow', value: <Money amount={frozen.escrowTotal} asset="POINTS" /> },
                  { key: 'Payout hash', value: <Mono title={frozen.payoutHash}>{frozen.payoutHash.slice(0, 16)}…</Mono> },
                ]}
              />
              <ul className="flex flex-col gap-1">
                {frozen.payouts.map((p) => (
                  <li key={p.userId} className="type-body" data-testid="payout-row">
                    #{p.placement} {nameOf.get(purseToPlayer.get(p.userId) ?? '') ?? p.userId}: <Money amount={p.payout} asset="POINTS" />
                  </li>
                ))}
              </ul>
              <div>
                <ActionButton variant="primary" onClick={() => onClose(frozen.payoutHash)} disabled={busy} data-testid="confirm-close">
                  Confirm and settle
                </ActionButton>
              </div>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

function Settled({ season }: { season: SeasonView }) {
  const settlement = season.settlement;
  if (settlement === null) return null;
  const purseToName = new Map((season.frozenPreview?.standings ?? []).map((s) => [s.purseUserId, season.ladder.find((row) => row.player.id === s.playerId)?.player.name ?? s.playerId]));
  return (
    <section aria-labelledby="settled-heading">
      <Card title={<span id="settled-heading">Settled on Purse</span>} actions={<Chip tone="surf">settled</Chip>}>
        <div data-testid="settlement" className="flex flex-col gap-2">
          <KeyValue items={[{ key: 'Payout hash', value: <Mono title={settlement.payoutHash}>{settlement.payoutHash.slice(0, 16)}…</Mono> }, { key: 'Settled', value: settlement.settledAt ?? '—' }]} />
          <ul className="flex flex-col gap-1">
            {settlement.results.map((r) => (
              <li key={r.userId} className="type-body" data-testid="result-row">
                #{r.placement} {purseToName.get(r.userId) ?? r.userId}: <Money amount={r.payoutAmount} asset="POINTS" />
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </section>
  );
}

/** A store that never changes: `useSyncExternalStore` then answers false on the server and true once hydrated. */
function subscribeNever(): () => void {
  return () => undefined;
}
