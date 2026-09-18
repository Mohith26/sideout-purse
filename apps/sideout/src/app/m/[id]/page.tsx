import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, Label, StateChip } from '../../../components/ui';
import { database } from '../../../db/client';
import { env } from '../../../env';
import { pageUser } from '../../../server/auth/current-user';
import { consensusView, viewerSide } from '../../../server/consensus';
import { matchView } from '../../../server/matches';
import { ScoreSheet } from './ScoreSheet';

export const dynamic = 'force-dynamic';

/** The match: who is playing, the agreed sets if any, and the score sheet for a player on either team (spec 5.3, "Match"). */
export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = database();
  const view = await matchView(db, id);
  if (view === null) notFound();
  const user = await pageUser({ db, sessionSecret: env().sessionSecret, now: new Date() });
  const consensus = await consensusView(db, id);
  const side = await viewerSide(db, { teamAId: view.match.teamAId, teamBId: view.match.teamBId }, user?.id ?? null);
  const teamA = view.teamA === null ? null : { id: view.teamA.id, name: view.teamA.name };
  const teamB = view.teamB === null ? null : { id: view.teamB.id, name: view.teamB.name };
  const label = view.match.poolId !== null ? `Pool play · round ${view.match.round}` : `Bracket · round ${view.match.round}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Label>
          <Link href={`/api/tournaments/${view.tournament.slug}`} className="hover:text-text-primary">
            {view.tournament.name}
          </Link>{' '}
          · {label}
        </Label>
        <h1 className="display text-display-l text-text-primary">
          {teamA?.name ?? 'TBD'} <span className="text-text-tertiary">v</span> {teamB?.name ?? 'TBD'}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <StateChip state={view.match.status.replace(/_/g, ' ')} />
          <StateChip state={consensus?.state ?? null} />
          {view.match.courtLabel === null ? null : <Label>{view.match.courtLabel}</Label>}
        </div>
      </header>

      {view.match.sets.length === 0 ? null : (
        <Card>
          <Label>Result</Label>
          <p className="display tabular mt-2 text-display-l text-text-primary" aria-live="polite">
            {view.match.sets.map((s) => `${s.teamAPoints}–${s.teamBPoints}`).join('  ')}
          </p>
          <p className="mt-1 text-body text-text-secondary">Sets from {teamA?.name ?? 'team A'}’s side.</p>
        </Card>
      )}

      <Card>
        <Label>Score sheet</Label>
        <div className="mt-3">
          <ScoreSheet
            matchId={view.match.id}
            bestOf={view.match.bestOf === 3 ? 3 : 1}
            status={view.match.status}
            teamA={teamA}
            teamB={teamB}
            viewerSide={side}
            signedIn={user !== null}
            agreedSets={view.match.sets.map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints }))}
            consensus={
              consensus === null
                ? null
                : {
                    state: consensus.state,
                    disputedReason: consensus.disputedReason,
                    differences: consensus.differences,
                    live: consensus.live.map((s) => ({ teamId: s.teamId, sets: s.sets, submittedBy: { displayName: s.submittedBy.displayName } })),
                    lastPushError: consensus.lastPushError === null ? null : { code: consensus.lastPushError.code, message: consensus.lastPushError.message },
                  }
            }
          />
        </div>
      </Card>
    </div>
  );
}
