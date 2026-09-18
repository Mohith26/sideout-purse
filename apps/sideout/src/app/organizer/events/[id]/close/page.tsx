import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, Chip, Label, Notice, StateChip } from '../../../../../components/ui';
import { tournaments } from '../../../../../db/schema';
import { env } from '../../../../../env';
import { pageUser } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import { closeStatus } from '../../../../../server/purse/close';
import { readBackEntries, reconcileEntries } from '../../../../../server/purse/contests';
import { requirePurse } from '../../../../../server/purse/deps';
import { CloseFlow } from './CloseFlow';
import { RetryButton } from './RetryButton';

export const dynamic = 'force-dynamic';

/**
 * The organizer's close page (spec 5.3, item 6): what blocks the close, named; the entry
 * reconciliation against Purse; then the two-step confirm against Purse's frozen preview.
 */
export default async function ClosePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = appContext();
  const { db } = app;
  const user = await pageUser({ db, sessionSecret: env().sessionSecret, now: new Date() });
  if (user?.role !== 'organizer') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="display text-display-l text-text-primary">Close tournament</h1>
        <Notice tone="warning" title="Organizers only">Sign in as an organizer to close a tournament.</Notice>
      </div>
    );
  }
  const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.id, id));
  if (row === undefined) notFound();

  let readBack: string | null = null;
  if (app.purse !== null) {
    const [current] = await db.select().from(tournaments).where(eq(tournaments.id, id));
    if (current !== undefined && current.status !== 'draft') {
      try {
        await readBackEntries(requirePurse(app), current, { requestId: `page-${id}`, now: new Date() });
      } catch (error) {
        readBack = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const status = await closeStatus(db, id);
  const reconciliation = await reconcileEntries(db, status.tournament);
  const t = status.tournament;
  const closable = t.status === 'awaiting_settlement' && status.blockers.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Label>Organizer · close tournament</Label>
        <h1 className="display text-display-l text-text-primary">{t.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={t.status === 'settled' ? 'positive' : t.status === 'awaiting_settlement' ? 'live' : 'neutral'}>{t.status.replace(/_/g, ' ')}</Chip>
          <Chip>{app.purse === null ? 'Purse not configured' : t.purseContestId === null ? 'no contest yet' : `contest ${t.purseContestState ?? 'unknown'}`}</Chip>
        </div>
      </header>

      <Card>
        <Label>Blockers</Label>
        {status.blockers.length === 0 ? (
          <p className="mt-2 text-body text-surf">{t.status === 'awaiting_settlement' ? 'Every match is final and confirmed with Purse.' : t.status === 'settled' ? 'Settled.' : `Nothing blocks the matches; the tournament is ${t.status.replace(/_/g, ' ')}.`}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {status.blockers.map((b) => (
              <li key={b.matchId} className="flex flex-col gap-1 rounded-input border border-border-subtle bg-bg-inset p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/m/${b.matchId}`} className="text-body text-text-primary hover:text-volt">
                    {b.label}: {b.teamA ?? 'TBD'} v {b.teamB ?? 'TBD'}
                  </Link>
                  <StateChip state={b.consensusState ?? b.matchStatus} />
                </div>
                <p className="text-body text-text-secondary">{b.reason}</p>
                {b.consensusState === 'disputed' ? (
                  <Link href="/organizer/disputes" className="text-[0.8125rem] text-volt">
                    Open the dispute queue
                  </Link>
                ) : b.consensusState === 'agreed' || b.consensusState === 'pushed_to_purse' ? (
                  <RetryButton matchId={b.matchId} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Label>Entries on Purse</Label>
        {readBack === null ? null : <p className="mt-2 text-body text-fault">Could not read the contest back: {readBack}</p>}
        <p className="mt-2 text-body text-text-secondary">
          {reconciliation.expected.length} players on confirmed teams · {reconciliation.expected.filter((e) => e.entered).length} entered · {reconciliation.missing.length} missing · {reconciliation.extra.length} extra
        </p>
        {reconciliation.missing.length === 0 ? null : (
          <ul className="mt-2 flex flex-col gap-1 text-body text-text-primary">
            {reconciliation.missing.map((m) => (
              <li key={m.userId}>
                <span className="text-volt">Missing:</span> {m.displayName} ({m.teamName}){m.linked ? '' : ' · not linked to Purse'}
              </li>
            ))}
          </ul>
        )}
        {reconciliation.extra.length === 0 ? null : (
          <ul className="mt-2 flex flex-col gap-1 text-body text-text-primary">
            {reconciliation.extra.map((x) => (
              <li key={x.purseUserId}>
                <span className="text-volt">Extra:</span> {x.displayName ?? x.purseUserId} holds an entry but is on no confirmed team
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Label>Close</Label>
        <div className="mt-3">
          {app.purse === null ? (
            <Notice tone="warning" title="Purse is not configured">Set SIDEOUT_PURSE_SECRET_KEY on the server to close through Purse.</Notice>
          ) : closable || t.status === 'settled' ? (
            <CloseFlow
              tournamentId={t.id}
              initial={
                status.frozen === null || status.standings === null
                  ? null
                  : {
                      payoutHash: status.frozen.payoutHash,
                      escrowTotal: status.frozen.escrowTotal,
                      contestState: status.frozen.contestState,
                      previewedAt: status.frozen.previewedAt,
                      standings: status.standings,
                      payouts: status.frozen.payouts,
                      entries: status.frozen.entries,
                    }
              }
            />
          ) : (
            <Notice title="Not yet">{t.status === 'awaiting_settlement' ? 'Clear the blockers above first.' : `The tournament must be awaiting settlement; it is ${t.status.replace(/_/g, ' ')}.`}</Notice>
          )}
        </div>
      </Card>
    </div>
  );
}
