import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EmptyState, Icons, StatusPill } from '@sideout/ui';

import { ForfeitControl } from '../../../../../components/organizer/ForfeitControl';
import { LiveRefresh } from '../../../../../components/motion/LiveRefresh';
import { ScoreDisplay } from '../../../../../components/motion/ScoreDisplay';
import { MATCH_STATUS_PILL, TOURNAMENT_STATUS_PILL } from '../../../../../components/status/pills';
import { MATCH_STATUSES, tournaments, type MatchStatus } from '../../../../../db/schema';
import { cx } from '../../../../../lib/cx';
import { formatTime } from '../../../../../lib/format';
import { bracketRoundLabel } from '../../../../../lib/rounds';
import { organizerPageContext, pageContext } from '../../../../../server/pages';
import { courtBoard, listMatchViews, type CourtBoardGroup, type MatchView } from '../../../../../server/screens';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  // Never `notFound()` from metadata (it would leave the not-found screen untitled); the page body refuses a stranger.
  const { app, user } = await pageContext();
  if (user?.role !== 'organizer') return { title: 'Not found' };
  const [row] = await app.db.select({ name: tournaments.name }).from(tournaments).where(eq(tournaments.id, id));
  return { title: row === undefined ? 'Live board' : `${row.name} board` };
}

const FORFEITABLE: ReadonlySet<MatchStatus> = new Set<MatchStatus>(['scheduled', 'in_progress', 'awaiting_scores', 'disputed']);

function StatusCounts({ byStatus }: { byStatus: Partial<Record<MatchStatus, number>> }) {
  const parts = MATCH_STATUSES.filter((s) => (byStatus[s] ?? 0) > 0);
  return (
    <span className="flex flex-wrap gap-1.5">
      {parts.map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <StatusPill spec={MATCH_STATUS_PILL[s]} size="sm" />
          <span className="tabular type-label text-text-tertiary">{byStatus[s]}</span>
        </span>
      ))}
    </span>
  );
}

function Sets({ view, side }: { view: MatchView; side: 'a' | 'b' }) {
  if (view.match.sets.length === 0 || view.match.status === 'disputed') return null;
  return (
    <span className={cx('tabular flex shrink-0 gap-2 type-stat', view.match.status === 'in_progress' ? 'text-surf' : 'text-text-secondary')}>
      {view.match.sets.map((s) => (
        <ScoreDisplay key={s.setNumber} value={side === 'a' ? s.teamAPoints : s.teamBPoints} className="w-6 text-end" />
      ))}
    </span>
  );
}

function CourtColumn({ group, bracketRounds, timeZone, live }: { group: CourtBoardGroup; bracketRounds: number; timeZone: string; live: boolean }) {
  return (
    <section aria-label={group.courtLabel} className="surface-raised flex min-w-0 flex-col rounded-card" data-testid="court-column">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2.5">
        <h2 className="type-subheading">{group.courtLabel}</h2>
        <StatusCounts byStatus={group.byStatus} />
      </div>
      <ol className="divide-y divide-border-subtle">
        {group.matches.map((view) => {
          const { match, teamA, teamB } = view;
          const current = match.id === group.currentMatchId;
          const roundLabel = match.poolId === null ? bracketRoundLabel(match.round, bracketRounds) : `${view.poolLabel ?? 'Pool'} · R${match.round}`;
          const winner = match.winnerTeamId;
          const forfeitable = live && FORFEITABLE.has(match.status) && teamA !== null && teamB !== null;
          return (
            <li key={match.id} data-match-id={match.id} data-current={current ? 'true' : undefined} className={cx('p-3', current && 'bg-bg-overlay')}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 type-label text-text-tertiary">
                  <span className="tabular">{match.scheduledAt === null ? '—' : formatTime(match.scheduledAt, timeZone)}</span>
                  <span className="truncate">{roundLabel}</span>
                  {current ? <span className={cx(match.status === 'in_progress' ? 'text-surf' : 'text-text-secondary')}>· now</span> : null}
                </span>
                <StatusPill spec={MATCH_STATUS_PILL[match.status]} size="sm" />
              </div>
              <div className="mt-2 space-y-1" aria-live={match.status === 'in_progress' ? 'polite' : undefined}>
                <div className={cx('flex items-center justify-between gap-3', winner !== null && winner === teamA?.id ? 'text-text-primary' : 'text-text-secondary')}>
                  <span className="min-w-0 truncate font-medium">{teamA === null ? 'TBD' : `${teamA.seed === null ? '' : `${teamA.seed} `}${teamA.name}`}</span>
                  <Sets view={view} side="a" />
                </div>
                <div className={cx('flex items-center justify-between gap-3', winner !== null && winner === teamB?.id ? 'text-text-primary' : 'text-text-secondary')}>
                  <span className="min-w-0 truncate font-medium">{match.status === 'bye' ? <span className="text-text-tertiary">Bye</span> : teamB === null ? 'TBD' : `${teamB.seed === null ? '' : `${teamB.seed} `}${teamB.name}`}</span>
                  <Sets view={view} side="b" />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <Link href={`/m/${match.id}`} className="target inline-flex items-center gap-1 type-label text-text-secondary hover:text-text-primary">
                  Match
                  <Icons.chevronRight size={14} />
                </Link>
                {forfeitable && teamA !== null && teamB !== null ? <ForfeitControl matchId={match.id} teamA={{ id: teamA.id, name: teamA.name }} teamB={{ id: teamB.id, name: teamB.name }} /> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Court-by-court live board (spec 5.3, item 6): every match on every court in schedule
 * order, what each court is playing now, and a quick forfeit for a match that can still
 * be resolved. Disputes are the dispute queue's job; the count here links there.
 */
export default async function LiveBoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { app } = await organizerPageContext();
  const [t] = await app.db.select().from(tournaments).where(eq(tournaments.id, id));
  if (t === undefined) notFound();
  const views = await listMatchViews(app.db, t.id);
  const board = courtBoard(views);
  const live = t.status === 'live';

  return (
    <div className="space-y-6">
      {live ? <LiveRefresh /> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/organizer/events/${t.id}`} className="target inline-flex items-center gap-1 rounded-input type-label text-text-secondary hover:text-text-primary">
            <Icons.chevronLeft size={14} />
            {t.name}
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-display-l">Live board</h1>
            <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
          </div>
          <div className="mt-2">
            <StatusCounts byStatus={board.byStatus} />
          </div>
        </div>
        {(board.byStatus.disputed ?? 0) > 0 ? (
          <Link href="/organizer/disputes" className="target inline-flex items-center gap-2 rounded-input border border-fault/40 bg-fault/10 px-3 type-label text-fault" data-testid="board-disputes">
            <Icons.triangleAlert size={16} />
            {`${board.byStatus.disputed} disputed`}
            <Icons.chevronRight size={14} />
          </Link>
        ) : null}
      </div>

      {board.courts.length === 0 ? (
        <EmptyState level={2} icon="grid" title="No matches yet" body="The board fills when the draw is generated." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {board.courts.map((group) => (
            <CourtColumn key={group.courtLabel} group={group} bracketRounds={board.bracketRounds} timeZone={t.venueTimezone} live={live} />
          ))}
        </div>
      )}
      {!live && board.courts.length > 0 ? <p className="type-label text-text-tertiary">Forfeits can only be recorded while the event is live.</p> : null}
    </div>
  );
}
