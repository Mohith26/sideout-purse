'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, Icons, StatusPill } from '@sideout/ui';

import type { BestOf } from '../../db/schema';
import type { SetScore } from '../../domain/scoreline';
import { api, type ApiResult } from '../../lib/api-client';
import { formatTime } from '../../lib/format';
import { AttestationBadge } from '../attestation/AttestationBadge';
import { useLiveHold } from '../motion/live-hold';
import { MATCH_STATUS_PILL } from '../status/pills';
import { ScorelineCompare, ScorelineTable } from './ScorelineCompare';
import { enteredRows, judgeRows, ScorelineEditor, toSetScores, visibleRows, type EditorSet } from './ScorelineEditor';

/**
 * One disputed match in the organizer queue (spec 5.3, item 6): both scorelines side by
 * side with the differing set marked, whether each was signed by a checked-in phone
 * (spec section 12, item 1: an unsigned reading is visible during arbitration), and a
 * resolve form built on the same steppers players use. The organizer's scoreline is
 * authoritative and attributed to them; after it lands the card shows who settled it and
 * how far the Purse push got.
 */
export type DisputeCardData = {
  match: { id: string; bestOf: BestOf; courtLabel: string | null; teamAId: string | null; teamBId: string | null };
  tournament: { name: string; slug: string };
  roundLabel: string;
  teamA: { id: string; name: string } | null;
  teamB: { id: string; name: string } | null;
  disputedReason: string | null;
  differences: readonly number[];
  submissions: Array<{ teamId: string | null; sets: SetScore[]; submittedBy: string; createdAt: string; attested: boolean }>;
  timeZone: string;
};

export type ResolveResponse = {
  consensus: { state: string; resolvedBy: { userId: string; displayName: string } | null };
  match: { status: string; winnerTeamId: string | null; sets: SetScore[] };
  purse: { status: string; error?: { message: string } } | null;
};

export type DisputeCardProps = {
  dispute: DisputeCardData;
  /** Test hook: the request to make instead of `POST /api/admin/matches/:id/resolve`. */
  resolve?: (matchId: string, sets: SetScore[]) => Promise<ApiResult<ResolveResponse>>;
};

export function DisputeCard({ dispute, resolve }: DisputeCardProps) {
  const router = useRouter();
  const { match, teamA, teamB } = dispute;
  const teamAName = teamA?.name ?? 'Team A';
  const teamBName = teamB?.name ?? 'Team B';
  const subA = dispute.submissions.find((s) => s.teamId === match.teamAId);
  const subB = dispute.submissions.find((s) => s.teamId === match.teamBId);
  const [rows, setRows] = useState<EditorSet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<ResolveResponse | null>(null);
  // From the moment the resolution is sent until the organizer moves on: the event lands before the
  // answer does, and "Settled by" belongs to a match that has already left the queue on the server.
  useLiveHold(busy || settled !== null);

  const visible = visibleRows(rows, match.bestOf);
  const verdict = judgeRows(visible, match.bestOf);
  const send = resolve ?? ((id: string, sets: SetScore[]) => api<ResolveResponse>(`/api/admin/matches/${id}/resolve`, { method: 'POST', body: { sets } }));
  const prefill = (sets: readonly SetScore[]) => setRows(sets.map((s) => ({ setNumber: s.setNumber, left: s.teamAPoints, right: s.teamBPoints })));

  const onResolve = async () => {
    if (!verdict.legal) return;
    setBusy(true);
    setError(null);
    const result = await send(match.id, toSetScores(enteredRows(visible)));
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // Stay on the card so the attribution is visible; the queue re-reads when the organizer dismisses it.
    setSettled(result.data);
  };

  const note = (sub: typeof subA) => (sub === undefined ? 'Not submitted' : `${sub.submittedBy} · ${formatTime(sub.createdAt, dispute.timeZone)}`);

  return (
    <article aria-labelledby={`dispute-${match.id}`} className="surface-raised rounded-card p-4 md:p-5" data-testid="dispute-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="type-label text-text-tertiary">
            {dispute.tournament.name} · {dispute.roundLabel}
            {match.courtLabel === null ? '' : ` · ${match.courtLabel}`}
          </p>
          <h2 id={`dispute-${match.id}`} className="mt-1 type-subheading">
            {teamAName} <span className="text-text-tertiary">vs</span> {teamBName}
          </h2>
        </div>
        <StatusPill spec={settled === null ? MATCH_STATUS_PILL.disputed : MATCH_STATUS_PILL.final} />
      </header>

      {settled !== null ? (
        <div className="mt-4 space-y-3" data-testid="dispute-settled">
          <div className="flex items-start gap-3 rounded-card border border-surf/40 bg-surf/10 p-4">
            <Icons.circleCheck size={20} className="mt-0.5 shrink-0 text-surf" />
            <p className="text-text-primary">
              Settled by <span className="font-medium">{settled.consensus.resolvedBy?.displayName ?? 'the organizer'}</span>. The match is final and the result is recorded under their name in the audit log.
              {settled.purse === null ? '' : settled.purse.error === undefined ? ` Purse: ${settled.purse.status.replace(/_/g, ' ')}.` : ` Purse: ${settled.purse.error.message}`}
            </p>
          </div>
          {settled.match.sets.length > 0 ? (
            <ScorelineTable teamA={teamAName} teamB={teamBName} sets={settled.match.sets} winner={settled.match.winnerTeamId === match.teamAId ? 'a' : settled.match.winnerTeamId === match.teamBId ? 'b' : null} />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <ActionButton variant="secondary" onClick={() => router.refresh()}>
              Dismiss from the queue
            </ActionButton>
            <Link href={`/m/${match.id}`} className="so-button so-button--ghost">
              Open match
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 text-text-secondary">{dispute.disputedReason ?? 'The two scorelines differ.'}</p>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Who signed each reading" data-testid="dispute-signatures">
            {[
              { team: teamAName, sub: subA, id: match.teamAId },
              { team: teamBName, sub: subB, id: match.teamBId },
            ].map(({ team, sub, id }) => (
              <li key={id ?? team} className="inline-flex items-center gap-2 text-text-secondary" data-team={id ?? ''}>
                <span>{team}</span>
                {sub === undefined ? <span className="type-label text-text-tertiary">not submitted</span> : <AttestationBadge attested={sub.attested} who={sub.submittedBy} />}
              </li>
            ))}
          </ul>
          <ScorelineCompare
            className="mt-4"
            teamA={teamAName}
            teamB={teamBName}
            left={{ label: teamAName, sets: subA?.sets ?? [], note: note(subA) }}
            right={{ label: teamBName, sets: subB?.sets ?? [], note: note(subB) }}
            differingSets={dispute.differences}
          />

          <section aria-labelledby={`resolve-${match.id}`} className="mt-5 border-t border-border-subtle pt-5">
            <h3 id={`resolve-${match.id}`} className="type-label text-text-tertiary">
              Resolve with the authoritative scoreline
            </h3>
            <p className="mt-1 text-text-secondary">Start from either reading or type the result you established on the court. What you submit is final and recorded as your decision.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton variant="secondary" onClick={() => prefill(subA?.sets ?? [])} disabled={subA === undefined || busy}>
                Start from {teamAName}
              </ActionButton>
              <ActionButton variant="secondary" onClick={() => prefill(subB?.sets ?? [])} disabled={subB === undefined || busy}>
                Start from {teamBName}
              </ActionButton>
            </div>
            <div className="mt-4">
              <ScorelineEditor bestOf={match.bestOf} leftLabel={teamAName} rightLabel={teamBName} value={rows} onChange={setRows} disabled={busy} />
            </div>
            {error === null ? null : (
              <p role="alert" className="so-inline-alert mt-4">
                <Icons.circleAlert size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}
            <div className="mt-4">
              <ActionButton variant="primary" large onClick={() => void onResolve()} disabled={!verdict.legal || busy} aria-busy={busy}>
                {busy ? 'Resolving…' : 'Resolve as organizer'}
              </ActionButton>
            </div>
          </section>
        </>
      )}
    </article>
  );
}
