import Link from 'next/link';

import { Card, Label, Notice } from '../../../components/ui';
import { database } from '../../../db/client';
import { env } from '../../../env';
import { pageUser } from '../../../server/auth/current-user';
import { listDisputes } from '../../../server/consensus';
import { ResolveForm } from './ResolveForm';

export const dynamic = 'force-dynamic';

/** The dispute queue: every match whose two teams disagree, oldest first, with the two readings side by side and the organizer's resolution (spec 5.3, item 6). */
export default async function DisputesPage() {
  const { db } = database();
  const user = await pageUser({ db, sessionSecret: env().sessionSecret, now: new Date() });
  if (user?.role !== 'organizer') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="display text-display-l text-text-primary">Disputes</h1>
        <Notice tone="warning" title="Organizers only">Sign in as an organizer to see the dispute queue.</Notice>
      </div>
    );
  }
  const disputes = await listDisputes(db);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Label>Organizer</Label>
        <h1 className="display text-display-l text-text-primary">Disputes</h1>
        <p className="text-body text-text-secondary">{disputes.length === 0 ? 'Nothing to settle. Every scored match has both teams agreeing.' : `${disputes.length} match${disputes.length === 1 ? '' : 'es'} where the two readings differ. Settle each with the scoreline you can verify; the result is final and pushed to Purse.`}</p>
      </header>
      {disputes.map((d) => {
        const ours = d.consensus.live.find((s) => s.teamId === d.teamA?.id);
        const theirs = d.consensus.live.find((s) => s.teamId === d.teamB?.id);
        const differing = new Set(d.consensus.differences.map((x) => x.setNumber));
        const numbers = [...new Set([...(ours?.sets ?? []), ...(theirs?.sets ?? [])].map((s) => s.setNumber))].sort((x, y) => x - y);
        return (
          <Card key={d.match.id}>
            <div className="flex flex-col gap-1">
              <Label>
                {d.tournament.name} · {d.poolLabel === null ? `Bracket · round ${d.match.round}` : `${d.poolLabel} · round ${d.match.round}`}
              </Label>
              <h2 className="display text-heading text-text-primary">
                {d.teamA?.name ?? 'TBD'} <span className="text-text-tertiary">v</span> {d.teamB?.name ?? 'TBD'}
              </h2>
              <p className="text-body text-fault">{d.consensus.disputedReason ?? 'The scorelines differ.'}</p>
              <Link href={`/m/${d.match.id}`} className="text-[0.8125rem] text-text-tertiary hover:text-text-primary">
                Open the match
              </Link>
            </div>
            <table className="mt-4 w-full text-body">
              <thead>
                <tr className="text-left">
                  <th className="label py-1 text-text-secondary">Set</th>
                  <th className="label py-1 text-text-secondary">{d.teamA?.name ?? 'Team A'} reported</th>
                  <th className="label py-1 text-text-secondary">{d.teamB?.name ?? 'Team B'} reported</th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((n) => {
                  const a = ours?.sets.find((s) => s.setNumber === n);
                  const b = theirs?.sets.find((s) => s.setNumber === n);
                  return (
                    <tr key={n} className={differing.has(n) ? 'text-volt' : 'text-text-primary'}>
                      <td className="py-1">Set {n}{differing.has(n) ? ' · differs' : ''}</td>
                      <td className="tabular py-1">{a === undefined ? 'not reported' : `${a.teamAPoints}–${a.teamBPoints}`}</td>
                      <td className="tabular py-1">{b === undefined ? 'not reported' : `${b.teamAPoints}–${b.teamBPoints}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1 text-[0.8125rem] text-text-tertiary">Both columns are from {d.teamA?.name ?? 'team A'}’s side of the match. Submitted by {ours?.submittedBy.displayName ?? '—'} and {theirs?.submittedBy.displayName ?? '—'}.</p>
            <div className="mt-4 border-t border-border-subtle pt-4">
              <Label>Resolution ({d.teamA?.name ?? 'team A'}’s points first)</Label>
              <div className="mt-2">
                <ResolveForm matchId={d.match.id} bestOf={d.match.bestOf === 3 ? 3 : 1} teamA={d.teamA?.name ?? 'Team A'} teamB={d.teamB?.name ?? 'Team B'} initial={ours?.sets ?? []} />
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
