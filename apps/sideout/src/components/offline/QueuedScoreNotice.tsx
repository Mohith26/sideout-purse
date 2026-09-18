'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActionButton, Icons } from '@sideout/ui';

import type { SetScore, Side } from '../../domain/scoreline';
import { formatTime } from '../../lib/format';
import { discardQueued, OUTBOX_REPLAYED_EVENT, subscribeOutbox } from '../../lib/offline/client';
import type { OutboxItem, ReplayReport } from '../../lib/offline/outbox';
import { ScorelineTable } from '../consensus/ScorelineCompare';

/**
 * On the match page: the scoreline this phone has queued for the match, as it will be
 * sent, with an honest state (waiting for a connection, or refused once it was tried) and
 * a way to discard it. When a replay lands the page re-renders so the consensus it
 * produced shows instead.
 */
export function QueuedScoreNotice({ matchId, teamA, teamB, perspective, timeZone }: { matchId: string; teamA: string; teamB: string; perspective: Side; timeZone: string }) {
  const router = useRouter();
  const [item, setItem] = useState<OutboxItem | null>(null);

  useEffect(() => subscribeOutbox((items) => setItem(items.find((i) => i.matchId === matchId) ?? null)), [matchId]);

  useEffect(() => {
    const onReplayed = (event: Event) => {
      const report = (event as CustomEvent<ReplayReport>).detail;
      if (report.outcomes.some((o) => o.item.matchId === matchId && o.result !== 'deferred')) router.refresh();
    };
    window.addEventListener(OUTBOX_REPLAYED_EVENT, onReplayed);
    return () => window.removeEventListener(OUTBOX_REPLAYED_EVENT, onReplayed);
  }, [matchId, router]);

  if (item === null) return null;
  const sets: SetScore[] = item.body.sets.map((s) =>
    perspective === 'a' ? { setNumber: s.setNumber, teamAPoints: s.usPoints, teamBPoints: s.themPoints } : { setNumber: s.setNumber, teamAPoints: s.themPoints, teamBPoints: s.usPoints },
  );
  const failed = item.status === 'failed';
  return (
    <section aria-labelledby="queued-heading" data-testid="queued-score" data-status={item.status} className={failed ? 'rounded-card border border-fault/40 bg-fault/10 p-4' : 'surface-inset rounded-card p-4'}>
      <div className="flex items-start gap-3">
        {failed ? <Icons.circleAlert size={20} className="mt-0.5 shrink-0 text-fault" /> : <Icons.wifiOff size={20} className="mt-0.5 shrink-0 text-text-tertiary" />}
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 id="queued-heading" className="type-subheading text-text-primary">
              {failed ? 'Your queued scoreline was refused' : 'Queued on this phone'}
            </h2>
            <p className="mt-1 text-text-secondary">
              {failed
                ? `${item.lastError?.message ?? 'The server did not accept it.'} Discard it and enter the result again.`
                : `Saved ${formatTime(new Date(item.createdAt), timeZone)} with no connection. It will be sent as soon as this phone is back online, the same way and with the same checks, and nothing is final until both teams agree.`}
            </p>
          </div>
          <ScorelineTable teamA={teamA} teamB={teamB} sets={sets} winner={null} />
          <ActionButton variant="ghost" onClick={() => void discardQueued(item.id)} iconStart={<Icons.x size={16} />}>
            Discard queued scoreline
          </ActionButton>
        </div>
      </div>
    </section>
  );
}
