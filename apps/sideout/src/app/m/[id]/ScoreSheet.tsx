'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { DECIDING_SET_TARGET, judgeMatch, judgeSet, SET_TARGET, setTarget, type SetScore, type Side } from '../../../domain/scoreline';
import { Button, Chip, Notice, StateChip } from '../../../components/ui';

/**
 * The score sheet (spec 5.3, "Match"): one row per set, large steppers, legality judged
 * as the player types with the same rules the server applies, and the three states after
 * a submission: waiting on the other team, agreed (one decisive check), or a neutral
 * side-by-side disagreement with the differing set marked. The player types their own
 * points first; the server flips them to the match's orientation and hashes.
 */
type Difference = { setNumber: number; a: SetScore | null; b: SetScore | null };

export type SheetConsensus = {
  state: string;
  disputedReason: string | null;
  differences: Difference[];
  live: Array<{ teamId: string | null; sets: SetScore[]; submittedBy: { displayName: string } }>;
  lastPushError: { code: string; message: string } | null;
} | null;

type Props = {
  matchId: string;
  bestOf: 1 | 3;
  status: string;
  teamA: { id: string; name: string } | null;
  teamB: { id: string; name: string } | null;
  viewerSide: Side | null;
  signedIn: boolean;
  agreedSets: SetScore[];
  consensus: SheetConsensus;
};

type SetRow = { setNumber: number; us: number; them: number };

function initialRows(bestOf: 1 | 3): SetRow[] {
  return Array.from({ length: bestOf === 3 ? 2 : 1 }, (_, i) => ({ setNumber: i + 1, us: 0, them: 0 }));
}

export function ScoreSheet(props: Props) {
  const [rows, setRows] = useState<SetRow[]>(() => initialRows(props.bestOf));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ outcome: string; consensus: SheetConsensus; match: { sets: SetScore[] }; purse: { status: string; error?: { message: string } } | null } | null>(null);
  const router = useRouter();

  const us = props.viewerSide === 'a' ? props.teamA : props.teamB;
  const them = props.viewerSide === 'a' ? props.teamB : props.teamA;
  const oriented: SetScore[] = useMemo(
    () => rows.map((r) => ({ setNumber: r.setNumber, teamAPoints: props.viewerSide === 'b' ? r.them : r.us, teamBPoints: props.viewerSide === 'b' ? r.us : r.them })),
    [rows, props.viewerSide],
  );
  const verdict = useMemo(() => judgeMatch(oriented, props.bestOf), [oriented, props.bestOf]);
  const consensus = outcome?.consensus ?? props.consensus;
  const state = consensus?.state ?? null;
  const decided = props.status === 'final' || props.status === 'disputed' || props.status === 'forfeited' || outcome !== null;

  const bump = (index: number, who: 'us' | 'them', delta: number) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [who]: Math.max(0, Math.min(99, row[who] + delta)) } : row)));
  };
  const addSet = () => setRows((current) => (current.length < props.bestOf ? [...current, { setNumber: current.length + 1, us: 0, them: 0 }] : current));
  const dropSet = () => setRows((current) => (current.length > 1 ? current.slice(0, -1) : current));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/matches/${props.matchId}/scores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sets: rows.map((r) => ({ setNumber: r.setNumber, usPoints: r.us, themPoints: r.them })) }),
      });
      const body = (await response.json()) as { data?: { outcome: string; consensus: SheetConsensus; match: { sets: SetScore[] }; purse: { status: string; error?: { message: string } } | null }; error?: { message: string } };
      if (body.data === undefined) {
        setError(body.error?.message ?? `The submission failed (${response.status}).`);
        return;
      }
      setOutcome(body.data);
      // The header's chips and the result line are server-rendered; refresh them.
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The submission failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!props.signedIn) return <Notice title="Sign in to enter a score">Only a player on one of the two teams can submit this match’s scoreline.</Notice>;
  if (props.viewerSide === null) return <Notice title="You are not on this match">Only a player on one of the two teams can submit this match’s scoreline.</Notice>;

  return (
    <div className="flex flex-col gap-4">
      {decided ? (
        <AfterSubmit
          state={state}
          outcome={outcome?.outcome ?? null}
          status={props.status}
          consensus={consensus}
          us={us}
          them={them}
          agreedSets={outcome !== null && outcome.match.sets.length > 0 ? outcome.match.sets : props.agreedSets}
          purse={outcome?.purse ?? null}
        />
      ) : null}
      {decided ? null : (
        <div className="flex flex-col gap-3" aria-live="polite">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 text-text-secondary">
            <span className="label">Set</span>
            <span className="label text-center">{us?.name ?? 'Us'}</span>
            <span className="label text-center">{them?.name ?? 'Them'}</span>
          </div>
          {rows.map((row, index) => {
            const target = setTarget(row.setNumber, props.bestOf);
            const set = judgeSet(row.us, row.them, target);
            return (
              <div key={row.setNumber} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-input border border-border-subtle bg-bg-inset p-2">
                <div className="min-w-0">
                  <p className="text-body text-text-primary">
                    Set {row.setNumber} <span className="text-text-tertiary">to {target}</span>
                  </p>
                  <p className={`text-[0.8125rem] ${set.legal ? 'text-surf' : 'text-text-tertiary'}`}>{set.legal ? `Won by ${set.winner === 'a' ? 'us' : 'them'}` : set.reason}</p>
                </div>
                <Stepper value={row.us} onChange={(delta) => bump(index, 'us', delta)} label={`${us?.name ?? 'us'} set ${row.setNumber}`} />
                <Stepper value={row.them} onChange={(delta) => bump(index, 'them', delta)} label={`${them?.name ?? 'them'} set ${row.setNumber}`} />
              </div>
            );
          })}
          {props.bestOf === 3 ? (
            <div className="flex gap-2">
              <Button onClick={addSet} disabled={rows.length >= 3}>
                Add a deciding set (to {DECIDING_SET_TARGET})
              </Button>
              <Button onClick={dropSet} disabled={rows.length <= 1}>
                Remove the last set
              </Button>
            </div>
          ) : null}
          <p className={`text-body ${verdict.legal ? 'text-surf' : 'text-text-secondary'}`} role="status">
            {verdict.legal
              ? `Legal: ${verdict.winner === props.viewerSide ? 'we' : 'they'} won ${verdict.setsWon[verdict.winner]}–${verdict.setsWon[verdict.winner === 'a' ? 'b' : 'a']} in sets.`
              : verdict.reason}
          </p>
          <p className="text-[0.8125rem] text-text-tertiary">
            Sets to {SET_TARGET}, win by two{props.bestOf === 3 ? `, a deciding set to ${DECIDING_SET_TARGET}` : ''}. Both teams submit; the result stands when the two readings match.
          </p>
          {error === null ? null : <Notice tone="error" title="Not accepted">{error}</Notice>}
          <Button primary onClick={() => void submit()} disabled={busy || !verdict.legal}>
            {busy ? 'Submitting…' : 'Submit our scoreline'}
          </Button>
        </div>
      )}
    </div>
  );
}

function Stepper({ value, onChange, label }: { value: number; onChange: (delta: number) => void; label: string }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <button type="button" aria-label={`${label}: one fewer`} onClick={() => onChange(-1)} className="h-12 w-12 rounded-input border border-border-strong text-heading text-text-primary">
        −
      </button>
      <span className="display tabular w-12 text-center text-heading text-text-primary" aria-live="polite">
        {value}
      </span>
      <button type="button" aria-label={`${label}: one more`} onClick={() => onChange(1)} className="h-12 w-12 rounded-input border border-border-strong text-heading text-text-primary">
        +
      </button>
    </div>
  );
}

function AfterSubmit(props: {
  state: string | null;
  outcome: string | null;
  status: string;
  consensus: SheetConsensus;
  us: { id: string; name: string } | null;
  them: { id: string; name: string } | null;
  agreedSets: SetScore[];
  purse: { status: string; error?: { message: string } } | null;
}) {
  const { consensus } = props;
  if (props.status === 'forfeited') return <Notice title="Forfeited">The organizer recorded a forfeit for this match.</Notice>;
  if (props.state === 'awaiting_second') {
    return (
      <Notice title={`Waiting on ${props.them?.name ?? 'the other team'}`}>
        Your scoreline is recorded. The match is final once the other team submits the same result; if their reading differs, the organizer settles it.
      </Notice>
    );
  }
  if (props.state === 'disputed') {
    const ours = consensus?.live.find((s) => s.teamId === props.us?.id)?.sets ?? [];
    const theirs = consensus?.live.find((s) => s.teamId === props.them?.id)?.sets ?? [];
    const differing = new Set((consensus?.differences ?? []).map((d) => d.setNumber));
    const numbers = [...new Set([...ours, ...theirs].map((s) => s.setNumber))].sort((x, y) => x - y);
    // Live submissions are match-oriented: team A's points first, whichever team typed them.
    const shown = (set: SetScore | undefined): string => (set === undefined ? '—' : `${set.teamAPoints}–${set.teamBPoints}`);
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="warning" title="The two readings differ">
          {consensus?.disputedReason ?? 'The scorelines differ.'} The organizer will settle it; nothing more can be submitted.
        </Notice>
        <table className="w-full text-body">
          <thead>
            <tr className="text-left text-text-secondary">
              <th className="label py-1">Set</th>
              <th className="label py-1">{props.us?.name ?? 'Us'} reported</th>
              <th className="label py-1">{props.them?.name ?? 'Them'} reported</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
              <tr key={n} className={differing.has(n) ? 'text-volt' : 'text-text-primary'}>
                <td className="py-1">Set {n}{differing.has(n) ? ' · differs' : ''}</td>
                <td className="tabular py-1">{shown(ours.find((s) => s.setNumber === n))}</td>
                <td className="tabular py-1">{shown(theirs.find((s) => s.setNumber === n))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[0.8125rem] text-text-tertiary">Scores are shown from team A’s side of the match.</p>
      </div>
    );
  }
  const agreed = props.state === 'agreed' || props.state === 'pushed_to_purse' || props.state === 'confirmed';
  if (agreed) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-pill border-2 border-surf text-surf">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 10.5l4 4 8-9" />
            </svg>
          </span>
          <div>
            <p className="text-subheading text-text-primary">Both teams agree. The result is final.</p>
            <p className="text-body text-text-secondary">
              {props.agreedSets.map((s) => `${s.teamAPoints}–${s.teamBPoints}`).join(', ')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StateChip state={props.state} />
          {props.purse?.error === undefined ? null : <Chip tone="warning">Purse: {props.purse.error.message}</Chip>}
          {consensus?.lastPushError === null || consensus?.lastPushError === undefined ? null : <Chip tone="warning">Purse: {consensus.lastPushError.message}</Chip>}
        </div>
      </div>
    );
  }
  return <Notice title="Recorded">Your submission is recorded.</Notice>;
}
