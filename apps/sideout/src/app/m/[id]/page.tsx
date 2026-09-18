import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState, Icons, LinkButton, LiveDot, StatusPill } from '@sideout/ui';

import { ConsensusBadge } from '../../../components/consensus/ConsensusBadge';
import { ScorelineCompare, ScorelineTable } from '../../../components/consensus/ScorelineCompare';
import { ScoreSubmitSheet } from '../../../components/consensus/ScoreSubmitSheet';
import { LiveRefresh } from '../../../components/motion/LiveRefresh';
import { ScoreDisplay } from '../../../components/motion/ScoreDisplay';
import { QueuedScoreNotice } from '../../../components/offline/QueuedScoreNotice';
import { CONSENSUS_STATE_PILL, MATCH_STATUS_PILL } from '../../../components/status/pills';
import { TeamAvatarPair } from '../../../components/tournament/TeamAvatarPair';
import { toPerspective } from '../../../domain/consensus';
import { cx } from '../../../lib/cx';
import { formatTime } from '../../../lib/format';
import { signInHref } from '../../../lib/redirects';
import { bracketRoundLabel } from '../../../lib/rounds';
import { consensusView, viewerSide } from '../../../server/consensus';
import { matchView } from '../../../server/matches';
import { pageContext } from '../../../server/pages';
import { bracketRoundCount, listMatchViews } from '../../../server/screens';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { app } = await pageContext();
  const view = await matchView(app.db, id);
  return { title: view === null ? 'Match' : `${view.teamA?.name ?? 'TBD'} vs ${view.teamB?.name ?? 'TBD'}` };
}

/**
 * The match (spec 5.3, item 3): who is playing, the sets as they stand (rolling while
 * live), where the consensus is, and the score sheet as a bottom sheet for a player on
 * either team. A disputed match shows the two readings side by side with the differing
 * set marked, neutrally; the organizer settles it from the dispute queue.
 */
export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { app, user } = await pageContext();
  const { db } = app;
  const view = await matchView(db, id);
  if (view === null) notFound();
  const [consensus, side, all] = await Promise.all([consensusView(db, id), viewerSide(db, { teamAId: view.match.teamAId, teamBId: view.match.teamBId }, user?.id ?? null), listMatchViews(db, view.tournament.id)]);
  const bracketRounds = bracketRoundCount(all);
  const poolLabel = all.find((v) => v.match.id === id)?.poolLabel ?? null;
  const { match } = view;
  const teamA = view.teamA;
  const teamB = view.teamB;
  const roundLabel = match.poolId !== null ? `${poolLabel ?? 'Pool'} · round ${match.round}` : bracketRoundLabel(match.round, bracketRounds);
  const live = match.status === 'in_progress';
  const open = match.status === 'scheduled' || match.status === 'in_progress' || match.status === 'awaiting_scores';
  const tournamentLive = view.tournament.status === 'live';
  const us = side === 'a' ? teamA : side === 'b' ? teamB : null;
  const them = side === 'a' ? teamB : side === 'b' ? teamA : null;
  const timeZone = view.tournament.timezone;
  const mine = us === null ? undefined : consensus?.live.find((s) => s.teamId === us.id);
  const theirs = them === null ? undefined : consensus?.live.find((s) => s.teamId === them.id);
  const subA = consensus?.live.find((s) => s.teamId === match.teamAId);
  const subB = consensus?.live.find((s) => s.teamId === match.teamBId);
  const differing = (consensus?.differences ?? []).map((d) => d.setNumber);
  const winner = match.winnerTeamId === null ? null : match.winnerTeamId === match.teamAId ? 'a' : 'b';
  const bestOf = match.bestOf === 3 ? 3 : 1;
  const submittedBy = consensus?.live[0]?.teamName ?? null;
  const waitingOn = submittedBy === null ? null : submittedBy === teamA?.name ? (teamB?.name ?? null) : (teamA?.name ?? null);

  return (
    <div className="space-y-8">
      {tournamentLive && open ? <LiveRefresh /> : null}
      <header className="space-y-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-label text-text-tertiary">
          <Link href={`/t/${view.tournament.slug}`} className="target inline-flex items-center hover:text-text-primary">
            {view.tournament.name}
          </Link>
          <span>·</span>
          <span>{roundLabel}</span>
          {match.courtLabel === null ? null : (
            <>
              <span>·</span>
              <span>{match.courtLabel}</span>
            </>
          )}
          {match.scheduledAt === null ? null : (
            <>
              <span>·</span>
              <span className="tabular">{formatTime(match.scheduledAt, timeZone)}</span>
            </>
          )}
        </p>
        <h1 className="type-display-l">
          {teamA?.name ?? 'TBD'} <span className="text-text-tertiary">vs</span> {teamB?.name ?? 'TBD'}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill spec={MATCH_STATUS_PILL[match.status]} />
          {consensus === null ? null : <StatusPill spec={CONSENSUS_STATE_PILL[consensus.state]} />}
          {live ? (
            <span className="inline-flex items-center gap-2 type-label text-surf">
              <LiveDot />
              On the sand
            </span>
          ) : null}
        </div>
      </header>

      <section aria-labelledby="teams-heading" className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <h2 id="teams-heading" className="sr-only">
          Teams
        </h2>
        {[
          { team: teamA, side: 'a' as const },
          { team: teamB, side: 'b' as const },
        ].map(({ team, side: s }) => (
          <div key={s} className={cx('surface-raised flex items-center justify-between gap-3 rounded-card p-4', winner === s && 'border-surf/40')} data-testid={`team-${s}`}>
            {team === null ? <span className="text-text-tertiary">To be decided</span> : <TeamAvatarPair members={team.members} teamName={team.name} />}
            {winner === s ? (
              <span className="inline-flex items-center gap-1 type-label text-surf">
                <Icons.check size={14} />
                Winner
              </span>
            ) : side === s ? (
              <span className="type-label text-text-tertiary">Your team</span>
            ) : null}
          </div>
        ))}
      </section>

      {match.sets.length > 0 && match.status !== 'disputed' ? (
        <section aria-labelledby="result-heading" className="surface-raised rounded-card p-4 md:p-5">
          <h2 id="result-heading" className="type-label text-text-tertiary">
            {match.status === 'final' ? 'Result' : 'Sets so far'}
          </h2>
          <div aria-live="polite" className="mt-3 flex flex-wrap items-end gap-6" data-testid="result-line">
            {match.sets.map((s) => (
              <div key={s.setNumber} className="flex flex-col">
                <span className="type-label text-text-tertiary">Set {s.setNumber}</span>
                <span className={cx('type-display-xl flex items-baseline gap-2', live ? 'text-surf' : 'text-text-primary')}>
                  <ScoreDisplay value={s.teamAPoints} />
                  <span className="text-text-tertiary">–</span>
                  <ScoreDisplay value={s.teamBPoints} />
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 type-label text-text-tertiary">Sets read {teamA?.name ?? 'team A'} – {teamB?.name ?? 'team B'}.</p>
        </section>
      ) : null}

      <section aria-labelledby="consensus-heading" className="space-y-4">
        <h2 id="consensus-heading" className="type-label text-text-tertiary">
          Score consensus
        </h2>
        <ConsensusBadge state={consensus?.state ?? null} submittedBy={submittedBy} waitingOn={waitingOn} resolvedBy={consensus?.resolvedBy?.displayName ?? null} />

        {match.status === 'disputed' && consensus !== null ? (
          <ScorelineCompare
            teamA={teamA?.name ?? 'Team A'}
            teamB={teamB?.name ?? 'Team B'}
            left={{ label: teamA?.name ?? 'Team A', sets: subA?.sets ?? [], note: subA === undefined ? 'Not submitted' : `${subA.submittedBy.displayName}` }}
            right={{ label: teamB?.name ?? 'Team B', sets: subB?.sets ?? [], note: subB === undefined ? 'Not submitted' : `${subB.submittedBy.displayName}` }}
            differingSets={differing}
          />
        ) : null}
        {match.status === 'disputed' ? <p className="text-text-secondary">{consensus?.disputedReason ?? 'The two readings differ.'} The organizer settles it with both teams; nothing is final until then.</p> : null}

        {match.status === 'forfeited' ? <p className="text-text-secondary">The organizer recorded a forfeit. {winner === null ? '' : `${winner === 'a' ? teamA?.name : teamB?.name} advances.`}</p> : null}
        {match.status === 'bye' ? <p className="text-text-secondary">{teamA?.name ?? 'The team'} advances on a bye; there is nothing to score.</p> : null}

        {consensus?.lastPushError !== null && consensus?.lastPushError !== undefined ? (
          <p className="type-label text-text-tertiary">Purse: {consensus.lastPushError.message} The organizer can retry; the result stands.</p>
        ) : null}

        {us !== null && them !== null && user !== null ? (
          <div className="space-y-4" data-testid="submit-panel">
            <QueuedScoreNotice matchId={match.id} teamA={teamA?.name ?? 'Team A'} teamB={teamB?.name ?? 'Team B'} perspective={side === 'b' ? 'b' : 'a'} timeZone={timeZone} />
            {!tournamentLive ? (
              <EmptyState icon="clock" title={view.tournament.status === 'settled' || view.tournament.status === 'awaiting_settlement' ? 'Play is over' : 'Not yet'} body="Scores are entered while the tournament is live." />
            ) : open ? (
              <>
                {mine !== undefined ? (
                  <div className="space-y-2">
                    <p className="text-text-secondary">Your team’s scoreline as submitted{theirs === undefined ? `; waiting on ${them.name}.` : '.'}</p>
                    <ScorelineTable teamA={teamA?.name ?? 'Team A'} teamB={teamB?.name ?? 'Team B'} sets={mine.sets} winner={null} />
                  </div>
                ) : theirs !== undefined ? (
                  <p className="text-text-secondary">{them.name} has submitted a result. Enter yours from your side; if the two agree the match is final, if not the organizer settles it.</p>
                ) : null}
                <ScoreSubmitSheet
                  matchId={match.id}
                  bestOf={bestOf}
                  us={{ id: us.id, name: us.name }}
                  them={{ id: them.id, name: them.name }}
                  perspective={side === 'b' ? 'b' : 'a'}
                  existing={mine === undefined ? null : toPerspective(mine.sets, side === 'b' ? 'b' : 'a')}
                  opponentSubmitted={theirs !== undefined}
                />
              </>
            ) : null}
          </div>
        ) : user === null && open && tournamentLive ? (
          <p className="text-text-secondary">
            A player on either team enters the score from their own phone.{' '}
            <LinkButton component={Link} variant="ghost" href={signInHref(`/m/${match.id}`)}>
              Sign in
            </LinkButton>
          </p>
        ) : null}
      </section>

      {match.status === 'final' && match.sets.length > 0 ? <ScorelineTable teamA={teamA?.name ?? 'Team A'} teamB={teamB?.name ?? 'Team B'} sets={match.sets} winner={winner} /> : null}
    </div>
  );
}
