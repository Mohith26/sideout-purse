import { and, desc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icons, SectionHeading, StatusPill, type PillSpec } from '@sideout/ui';

import { CloseFlow } from '../../../../../components/consensus/CloseFlow';
import { FrozenPreview } from '../../../../../components/consensus/FrozenPreview';
import { RetryPushButton } from '../../../../../components/consensus/RetryPushButton';
import { CONSENSUS_STATE_PILL, MATCH_STATUS_PILL, TOURNAMENT_STATUS_PILL } from '../../../../../components/status/pills';
import { Notice } from '../../../../../components/ui/Notice';
import { auditLog, tournaments } from '../../../../../db/schema';
import { organizerPageContext, pageContext } from '../../../../../server/pages';
import { closeStatus } from '../../../../../server/purse/close';
import { readBackEntries, reconcileEntries } from '../../../../../server/purse/contests';
import { requirePurse } from '../../../../../server/purse/deps';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  // Never `notFound()` from metadata (it would leave the not-found screen untitled); the page body refuses a stranger.
  const { app, user } = await pageContext();
  if (user?.role !== 'organizer') return { title: 'Not found' };
  const [row] = await app.db.select({ name: tournaments.name }).from(tournaments).where(eq(tournaments.id, id));
  return { title: row === undefined ? 'Close' : `Close ${row.name}` };
}

const CONTEST_PILL = (state: string | null): PillSpec => ({ label: state === null ? 'No contest yet' : `Contest ${state.replace(/_/g, ' ')}`, tone: state === 'settled' ? 'success' : state === 'in_progress' || state === 'awaiting_settlement' ? 'live' : 'muted', icon: 'shieldCheck' });

/**
 * The organizer's close page (spec 5.3, item 6): what blocks the close, named; the entry
 * reconciliation against Purse; then the two-step confirm against Purse's frozen preview
 * and payout hash. A settled tournament shows the frozen preview it was closed with.
 */
export default async function ClosePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { app, now } = await organizerPageContext();
  const { db } = app;
  const [row] = await db.select({ id: tournaments.id, status: tournaments.status }).from(tournaments).where(eq(tournaments.id, id));
  if (row === undefined) notFound();

  let readBack: string | null = null;
  if (app.purse !== null && row.status !== 'draft') {
    const [current] = await db.select().from(tournaments).where(eq(tournaments.id, id));
    if (current !== undefined) {
      try {
        await readBackEntries(requirePurse(app), current, { requestId: `page-${id}`, now });
      } catch (error) {
        readBack = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const status = await closeStatus(db, id);
  const reconciliation = await reconcileEntries(db, status.tournament);
  const t = status.tournament;
  const closable = t.status === 'awaiting_settlement' && status.blockers.length === 0;
  const [closedAudit] = t.status === 'settled' ? await db.select({ createdAt: auditLog.createdAt }).from(auditLog).where(and(eq(auditLog.subjectId, t.id), eq(auditLog.action, 'tournament.closed'))).orderBy(desc(auditLog.createdAt)).limit(1) : [];

  return (
    <div className="space-y-10">
      <div className="min-w-0">
        <Link href={`/organizer/events/${t.id}`} className="target inline-flex items-center gap-1 rounded-input type-label text-text-secondary hover:text-text-primary">
          <Icons.chevronLeft size={14} />
          {t.name}
        </Link>
        <h1 className="type-display-l">Close tournament</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusPill spec={TOURNAMENT_STATUS_PILL[t.status]} />
          <StatusPill spec={CONTEST_PILL(app.purse === null ? null : t.purseContestId === null ? null : (t.purseContestState ?? 'unknown'))} />
        </div>
      </div>

      <section aria-labelledby="blockers-heading">
        <SectionHeading id="blockers-heading" aside={<span className="tabular">{status.blockers.length} blocking</span>}>
          Blockers
        </SectionHeading>
        {status.blockers.length === 0 ? (
          <Notice tone={t.status === 'awaiting_settlement' || t.status === 'settled' ? 'success' : 'info'} title={t.status === 'awaiting_settlement' ? 'Every match is final and confirmed with Purse' : t.status === 'settled' ? 'Settled' : 'Nothing blocks the matches'} testId="no-blockers">
            {t.status === 'awaiting_settlement' ? 'The close can proceed.' : t.status === 'settled' ? 'The tournament was closed through Purse.' : `The tournament is ${t.status.replace(/_/g, ' ')}; it must end play before it can close.`}
          </Notice>
        ) : (
          <ul className="space-y-2" data-testid="blockers">
            {status.blockers.map((b) => (
              <li key={b.matchId} className="surface-raised flex flex-col gap-2 rounded-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/m/${b.matchId}`} className="target inline-flex items-center font-medium text-text-primary hover:text-volt">
                    {b.label}: {b.teamA ?? 'TBD'} vs {b.teamB ?? 'TBD'}
                  </Link>
                  <StatusPill spec={b.consensusState === null ? MATCH_STATUS_PILL[b.matchStatus] : CONSENSUS_STATE_PILL[b.consensusState]} size="sm" />
                </div>
                <p className="text-text-secondary">{b.reason}</p>
                {b.consensusState === 'disputed' ? (
                  <Link href="/organizer/disputes" className="target inline-flex items-center gap-1 type-label text-fault">
                    <Icons.triangleAlert size={14} />
                    Open the dispute queue
                  </Link>
                ) : b.consensusState === 'agreed' || b.consensusState === 'pushed_to_purse' ? (
                  <RetryPushButton matchId={b.matchId} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="entries-heading">
        <SectionHeading id="entries-heading" aside={<span className="tabular">{reconciliation.expected.filter((e) => e.entered).length} of {reconciliation.expected.length} entered</span>}>
          Entries on Purse
        </SectionHeading>
        {readBack === null ? null : (
          <Notice tone="attention" title="Could not read the contest back">
            {readBack}
          </Notice>
        )}
        <div className="surface-raised rounded-card p-4">
          <p className="text-text-secondary">
            <span className="tabular">{reconciliation.expected.length}</span> players on confirmed teams · <span className="tabular">{reconciliation.expected.filter((e) => e.entered).length}</span> entered ·{' '}
            <span className="tabular">{reconciliation.missing.length}</span> missing · <span className="tabular">{reconciliation.extra.length}</span> extra
          </p>
          {reconciliation.missing.length === 0 ? null : (
            <ul className="mt-2 space-y-1 text-text-primary">
              {reconciliation.missing.map((m) => (
                <li key={m.userId}>
                  <span className="type-label text-fault">Missing</span> {m.displayName} ({m.teamName}){m.linked ? '' : ' · not linked to Purse'}
                </li>
              ))}
            </ul>
          )}
          {reconciliation.extra.length === 0 ? null : (
            <ul className="mt-2 space-y-1 text-text-primary">
              {reconciliation.extra.map((x) => (
                <li key={x.purseUserId}>
                  <span className="type-label text-fault">Extra</span> {x.displayName ?? x.purseUserId} holds an entry but is on no confirmed team
                </li>
              ))}
            </ul>
          )}
          {reconciliation.missing.length === 0 && reconciliation.extra.length === 0 ? <p className="mt-2 type-label text-surf">Purse holds exactly the players Sideout expects.</p> : null}
        </div>
      </section>

      <section aria-labelledby="close-heading">
        <SectionHeading id="close-heading">Close through Purse</SectionHeading>
        <div className="surface-raised rounded-card p-4 md:p-5">
          {app.purse === null ? (
            <Notice tone="attention" title="Purse is not configured">
              Set SIDEOUT_PURSE_SECRET_KEY on the server to close through Purse.
            </Notice>
          ) : t.status === 'settled' && status.frozen !== null && status.standings !== null ? (
            <FrozenPreview
              standings={status.standings}
              payouts={status.frozen.payouts}
              escrowTotal={status.frozen.escrowTotal}
              payoutHash={status.frozen.payoutHash}
              contestState={t.purseContestState ?? status.frozen.contestState}
              settledAt={closedAudit === undefined ? null : { at: closedAudit.createdAt.toISOString(), timeZone: t.venueTimezone }}
            />
          ) : closable ? (
            <CloseFlow
              tournamentId={t.id}
              timeZone={t.venueTimezone}
              initial={
                status.frozen === null || status.standings === null
                  ? null
                  : { payoutHash: status.frozen.payoutHash, escrowTotal: status.frozen.escrowTotal, contestState: status.frozen.contestState, previewedAt: status.frozen.previewedAt, standings: status.standings, payouts: status.frozen.payouts }
              }
            />
          ) : (
            <Notice tone="info" title="Not yet">
              {t.status === 'awaiting_settlement' ? 'Clear the blockers above first.' : t.status === 'settled' ? 'Settled; the frozen preview was not kept.' : `The tournament must be awaiting settlement; it is ${t.status.replace(/_/g, ' ')}.`}
            </Notice>
          )}
        </div>
      </section>
    </div>
  );
}
