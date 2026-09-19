'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { ActionButton, Icons, Sheet, SheetCloseButton } from '@sideout/ui';

import type { BestOf } from '../../db/schema';
import type { SubmittedAttestation } from '../../domain/attestation';
import type { SubmittedSet } from '../../domain/consensus';
import type { SetScore, Side } from '../../domain/scoreline';
import { api, type ApiResult } from '../../lib/api-client';
import { currentDeviceKey, signScoreline } from '../../lib/attestation/device';
import { queueScore } from '../../lib/offline/client';
import { AttestationMark } from '../attestation/AttestationBadge';
import { ConfirmCheck } from '../motion/ConfirmCheck';
import { useLiveHold } from '../motion/live-hold';
import { useConnectivity } from '../offline/useConnectivity';
import { ScorelineCompare, ScorelineTable } from './ScorelineCompare';
import { enteredRows, judgeRows, ScorelineEditor, toSetScores, visibleRows, type EditorSet } from './ScorelineEditor';

/**
 * The score sheet (spec 5.3, "Match"): a bottom sheet, thumb-reachable, one row per set,
 * large steppers, the legality of the scoreline judged live, and the submit button
 * disabled until it is legal. The submitter always types their own points first; the
 * server resolves which team they play for and flips the orientation.
 *
 * After submit, the sheet shows where the consensus went:
 *
 * - first submitter    → "Waiting on {opponent}" and why both teams must agree
 * - second, agreeing   → one decisive surf check, then "Final"
 * - second, differing  → both scorelines side by side, the differing set marked, and a
 *                        neutral note that the organizer settles it; no blame language
 * - no connection      → the scoreline is saved in the outbox on this phone
 *                        (`lib/offline`) and sent, unchanged, when it is back online;
 *                        the sheet says so plainly
 *
 * When this phone is checked in for the team (`signing.liveKeyIds` holds its key id), the
 * scoreline is signed here before it is sent or queued (spec section 12, item 1): the
 * signature binds the canonical, match-oriented sets to the tournament, the match and
 * the team, and the server verifies it against the check-in before the consensus sees
 * the submission. A phone that is not checked in sends the scoreline unsigned, and the
 * sheet says which it is doing.
 */

/** The wire shape of `POST /api/matches/:id/scores` this sheet reads. */
export type SubmitResponse = {
  outcome: 'awaiting_second' | 'agreed' | 'disputed';
  replaced: boolean;
  perspective: Side;
  match: { winnerTeamId: string | null; teamAId: string | null; teamBId: string | null; sets: SetScore[] };
  consensus: { state: string; disputedReason: string | null; live: Array<{ teamId: string | null; sets: SetScore[] }>; differences: Array<{ setNumber: number }> } | null;
  purse: { status: string; error?: { message: string } } | null;
};

export type ScoreSubmitSheetProps = {
  matchId: string;
  bestOf: BestOf;
  /** The viewer's team and the opponent. */
  us: { id: string; name: string };
  them: { id: string; name: string };
  /** Which side `us` is in match orientation. */
  perspective: Side;
  /** Our standing submission as typed (own points first), if we have one. */
  existing: readonly SubmittedSet[] | null;
  /** Whether the opponent has a standing submission. */
  opponentSubmitted: boolean;
  /** What a signature binds to, and the key ids checked in for `us`; null when signing is off (a spectator, a test). */
  signing?: { tournamentId: string; liveKeyIds: readonly string[] } | null;
  /** Test hook: the request to make instead of `POST /api/matches/:id/scores`; `status` 0 or 5xx means the phone should queue it. */
  submit?: (matchId: string, sets: SubmittedSet[], attestation: SubmittedAttestation | null) => Promise<ApiResult<SubmitResponse>>;
};

type Phase =
  | { kind: 'closed' }
  | { kind: 'editing'; error: string | null; busy: boolean }
  | { kind: 'waiting'; sets: SetScore[] }
  | { kind: 'agreed'; sets: SetScore[]; weWon: boolean; purseNote: string | null }
  | { kind: 'disputed'; ours: SetScore[]; theirs: SetScore[]; differing: number[] }
  | { kind: 'queued'; sets: SetScore[] };

function toEditor(sets: readonly SubmittedSet[]): EditorSet[] {
  return sets.map((s) => ({ setNumber: s.setNumber, left: s.usPoints, right: s.themPoints }));
}

/** Editor rows are "us first"; the match is "team A first". */
function orient(sets: readonly SetScore[], perspective: Side): SetScore[] {
  return sets.map((s) => (perspective === 'a' ? s : { setNumber: s.setNumber, teamAPoints: s.teamBPoints, teamBPoints: s.teamAPoints }));
}

/** A reply that says nothing about the submission (no connection, or a server that could not answer): queue it rather than lose it. */
export function shouldQueue(result: ApiResult<unknown>): boolean {
  if (result.ok) return false;
  return result.status === 0 || result.status >= 500;
}

const TITLES: Record<Exclude<Phase['kind'], 'closed'>, string> = {
  editing: 'Your result',
  waiting: 'Waiting on the other team',
  agreed: 'Final',
  disputed: 'Scorelines differ',
  queued: 'Saved on this phone',
};

export function ScoreSubmitSheet({ matchId, bestOf, us, them, perspective, existing, opponentSubmitted, signing = null, submit }: ScoreSubmitSheetProps) {
  const router = useRouter();
  const { offline } = useConnectivity();
  const [rows, setRows] = useState<EditorSet[]>(() => (existing === null ? [] : toEditor(existing)));
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' });
  const [signer, setSigner] = useState<'unknown' | 'checked_in' | 'not_checked_in'>('unknown');
  const open = phase.kind !== 'closed';
  const busy = phase.kind === 'editing' && phase.busy;
  // The beat after a submission stays on screen until "Done": a live event must not re-render it away.
  useLiveHold(open);

  const visible = visibleRows(rows, bestOf);
  const verdict = judgeRows(visible, bestOf);
  const send = submit ?? ((id: string, sets: SubmittedSet[], attestation: SubmittedAttestation | null) => api<SubmitResponse>(`/api/matches/${id}/scores`, { method: 'POST', body: attestation === null ? { sets } : { sets, attestation } }));

  /** This phone's key if the team checked it in; judged when the sheet opens so the copy can say what will happen. */
  const signingKey = useCallback(async () => {
    if (signing === null) return null;
    const key = await currentDeviceKey();
    return key !== null && signing.liveKeyIds.includes(key.keyId) ? key : null;
  }, [signing]);

  const openSheet = () => {
    setPhase({ kind: 'editing', error: null, busy: false });
    if (signing === null) return;
    void signingKey().then((key) => setSigner(key === null ? 'not_checked_in' : 'checked_in'));
  };

  const onClose = useCallback(() => {
    setPhase({ kind: 'closed' });
    // The server-rendered page reflects the consensus after any submission.
    router.refresh();
  }, [router]);

  const onSubmit = async () => {
    if (!verdict.legal) return;
    setPhase({ kind: 'editing', error: null, busy: true });
    const entered = enteredRows(visible);
    const sets: SubmittedSet[] = entered.map((r) => ({ setNumber: r.setNumber, usPoints: r.left, themPoints: r.right }));
    const ours = orient(toSetScores(entered), perspective);
    // Signed on the phone, over the match-oriented sets, bound to this tournament, match and team.
    const key = await signingKey();
    const attestation = key === null || signing === null ? null : await signScoreline(key, { tournamentId: signing.tournamentId, matchId, teamId: us.id }, ours);
    const queue = async () => {
      await queueScore(matchId, sets, attestation);
      setPhase({ kind: 'queued', sets: ours });
    };
    if (offline) {
      await queue();
      return;
    }
    const result = await send(matchId, sets, attestation);
    if (shouldQueue(result)) {
      await queue();
      return;
    }
    if (!result.ok) {
      const code = result.error.code;
      const message = code === 'already_decided' || code === 'match_not_open' || code === 'not_on_team' ? `${result.error.message} Close this sheet to see where the match stands.` : result.error.message;
      setPhase({ kind: 'editing', error: message, busy: false });
      return;
    }
    const data = result.data;
    if (data.outcome === 'awaiting_second') {
      setPhase({ kind: 'waiting', sets: ours });
    } else if (data.outcome === 'agreed') {
      const purseNote = data.purse?.error === undefined ? null : `Purse: ${data.purse.error.message.replace(/\.$/, '')}`;
      setPhase({ kind: 'agreed', sets: data.match.sets.length > 0 ? data.match.sets : ours, weWon: data.match.winnerTeamId === us.id, purseNote });
    } else {
      const theirs = data.consensus?.live.find((s) => s.teamId === them.id)?.sets ?? [];
      setPhase({ kind: 'disputed', ours, theirs, differing: (data.consensus?.differences ?? []).map((d) => d.setNumber) });
    }
  };

  const teamA = perspective === 'a' ? us.name : them.name;
  const teamB = perspective === 'a' ? them.name : us.name;
  const triggerLabel = existing !== null ? 'Change your scoreline' : opponentSubmitted ? 'Confirm the result' : 'Submit score';

  return (
    <>
      <ActionButton variant={existing !== null ? 'secondary' : 'primary'} large block onClick={openSheet} iconStart={<Icons.check size={18} />}>
        {triggerLabel}
      </ActionButton>

      <Sheet
        open={open}
        title={phase.kind === 'closed' ? '' : phase.kind === 'waiting' ? `Waiting on ${them.name}` : TITLES[phase.kind]}
        subtitle={`${us.name} vs ${them.name} · best of ${bestOf}`}
        locked={busy}
        onClose={onClose}
        testId="score-sheet"
        footer={
          phase.kind === 'editing' ? (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <SheetCloseButton variant="ghost" disabled={phase.busy}>
                Cancel
              </SheetCloseButton>
              <ActionButton variant="primary" large block onClick={() => void onSubmit()} disabled={!verdict.legal || phase.busy} aria-busy={phase.busy}>
                {phase.busy ? 'Sending…' : existing !== null ? 'Replace scoreline' : 'Submit scoreline'}
              </ActionButton>
            </div>
          ) : (
            <SheetCloseButton variant="secondary" large block>
              Done
            </SheetCloseButton>
          )
        }
      >
        {phase.kind === 'editing' ? (
          <>
            <p className="mb-4 text-text-secondary">
              Enter every set with <span className="text-text-primary">your</span> points first. {them.name} enters the same match from their side; the result is final once the two agree.
            </p>
            <ScorelineEditor bestOf={bestOf} leftLabel="Your team" rightLabel={them.name} value={rows} onChange={setRows} disabled={phase.busy} />
            {signing === null || signer === 'unknown' ? null : (
              <p className="mt-4 flex flex-wrap items-center gap-2 type-label text-text-tertiary" data-testid="signing-note" data-signer={signer}>
                <AttestationMark attested={signer === 'checked_in'} />
                {signer === 'checked_in' ? 'This phone is checked in: the scoreline is signed here before it is sent.' : 'This phone is not checked in for your team: the scoreline is sent unsigned.'}
              </p>
            )}
            {phase.error === null ? null : (
              <p role="alert" className="so-inline-alert mt-4">
                <Icons.circleAlert size={16} className="mt-0.5 shrink-0" />
                <span>{phase.error}</span>
              </p>
            )}
          </>
        ) : null}

        {phase.kind === 'waiting' ? (
          <div className="space-y-4" data-testid="waiting-notice">
            <div className="flex items-start gap-3 rounded-card border border-border-subtle bg-bg-raised p-4">
              <Icons.hourglass size={20} className="mt-0.5 shrink-0 text-text-secondary" />
              <p className="text-text-secondary">
                Your scoreline is in. Nothing is final until <span className="text-text-primary">{them.name}</span> submits the same result from their phone: both teams have to agree before a result counts.
              </p>
            </div>
            <ScorelineTable teamA={teamA} teamB={teamB} sets={phase.sets} winner={null} />
          </div>
        ) : null}

        {phase.kind === 'agreed' ? (
          <div className="space-y-4" data-testid="agreed-notice">
            <div className="flex items-center gap-4 rounded-card border border-surf/40 bg-surf/10 p-4">
              <ConfirmCheck />
              <p className="text-text-primary">Both teams agree. The match is final{phase.weWon ? '; your team wins.' : '.'}</p>
            </div>
            <ScorelineTable teamA={teamA} teamB={teamB} sets={phase.sets} winner={phase.weWon ? perspective : perspective === 'a' ? 'b' : 'a'} />
            {phase.purseNote === null ? null : <p className="type-label text-text-tertiary">{phase.purseNote}. The organizer can retry it; the result stands.</p>}
          </div>
        ) : null}

        {phase.kind === 'queued' ? (
          <div className="space-y-4" data-testid="queued-notice">
            <div className="flex items-start gap-3 rounded-card border border-border-subtle bg-bg-raised p-4">
              <Icons.wifiOff size={20} className="mt-0.5 shrink-0 text-text-secondary" />
              <p className="text-text-secondary">
                No connection right now. Your scoreline is saved on this phone and will be sent, with the same checks, as soon as you are back online. Nothing is final until{' '}
                <span className="text-text-primary">{them.name}</span> submits the same result.
              </p>
            </div>
            <ScorelineTable teamA={teamA} teamB={teamB} sets={phase.sets} winner={null} />
          </div>
        ) : null}

        {phase.kind === 'disputed' ? (
          <div className="space-y-4" data-testid="disputed-notice">
            <div className="flex items-start gap-3 rounded-card border border-fault/40 bg-fault/10 p-4">
              <Icons.triangleAlert size={20} className="mt-0.5 shrink-0 text-fault" />
              <p className="text-text-primary">The two scorelines do not match. The organizer will settle it with both teams; nothing is final until then.</p>
            </div>
            <ScorelineCompare teamA={teamA} teamB={teamB} left={{ label: 'Your team', sets: phase.ours }} right={{ label: them.name, sets: phase.theirs }} differingSets={phase.differing} />
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
