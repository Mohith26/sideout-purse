import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, DataTable, KeyValue, Money, Mono } from '@sideout/ui';
import type { ContestDetailResource, TenantDetailResource } from '@purse/types';

import { PageHead } from '../../../../../../components/PageHead';
import { StateChip } from '../../../../../../components/StateChip';
import { formatInstant } from '../../../../../../lib/format';
import { load } from '../../../../../../server/api';
import { CloseFlow } from './CloseFlow';
import { ContestActions } from './ContestActions';

export const metadata: Metadata = { title: 'Contest' };

/**
 * One contest: the resource with its escrow balance from the journal, the entrants with
 * their entry links into the ledger, the current scores, the results, and, in
 * `awaiting_settlement`, the close flow.
 */
export default async function ContestPage({ params }: { params: Promise<{ tenantId: string; contestId: string }> }) {
  const { tenantId, contestId } = await params;
  const path = `/tenants/${tenantId}/contests/${contestId}`;
  const [tenant, detail] = await Promise.all([load<TenantDetailResource>(`/tenants/${tenantId}`, path), load<ContestDetailResource>(path)]);
  const { contest, participants, scores, results } = detail;
  const scoreByUser = new Map(scores.map((score) => [score.userId, score]));
  const nameByUser = new Map(participants.map((each) => [each.userId, each.displayName ?? each.externalId]));
  return (
    <>
      <PageHead
        title={contest.title}
        crumbs={[{ label: 'Contests', href: '/contests' }, { label: tenant.name, href: `/tenants/${tenant.id}` }, { label: contest.externalId }]}
        actions={<StateChip value={contest.state} />}
      />
      <div className="grid grid--two">
        <Card title="Contest">
          <KeyValue
            items={[
              { key: 'Id', value: <Mono>{contest.id}</Mono> },
              { key: 'External id', value: <Mono>{contest.externalId}</Mono> },
              { key: 'Kind', value: contest.kind },
              { key: 'Settlement', value: contest.settlementPolicy },
              { key: 'Entry', value: <Money amount={contest.entryAmount} asset={contest.asset} /> },
              { key: 'Entrants', value: `${contest.participantCount}${contest.maxParticipants === null ? '' : ` / ${contest.maxParticipants}`}` },
              { key: 'Prize structure', value: <Mono>{JSON.stringify(contest.prizeStructure)}</Mono> },
              { key: 'Tie break', value: contest.tieBreak },
              { key: 'Ruleset', value: contest.eligibilityRulesetVersion ?? '—' },
              { key: 'Opens', value: formatInstant(contest.opensAt) },
              { key: 'Locks', value: formatInstant(contest.locksAt) },
              { key: 'Settled', value: formatInstant(contest.settledAt) },
            ]}
          />
        </Card>
        <Card title="Escrow">
          <div className="so-stat">
            <span className="so-stat__value">
              <Money amount={contest.escrowBalance} asset={contest.asset} />
            </span>
            <span className="label">In escrow now, derived from the journal</span>
          </div>
          <KeyValue
            items={[
              {
                key: 'Account',
                value: (
                  <Link href={`/accounts/${contest.escrowAccountId}`} className="so-link so-mono">
                    {contest.escrowAccountId}
                  </Link>
                ),
              },
              {
                key: 'Journal',
                value: (
                  <Link href={`/tenants/${tenant.id}/ledger?contestId=${contest.id}`} className="so-link">
                    Entries of this contest
                  </Link>
                ),
              },
            ]}
          />
          <ContestActions tenantId={tenant.id} contest={contest} />
        </Card>
      </div>
      {contest.state === 'awaiting_settlement' || contest.state === 'settling' ? <CloseFlow tenantId={tenant.id} contestId={contest.id} asset={contest.asset} names={Object.fromEntries(nameByUser)} /> : null}
      <Card title="Entrants">
        <DataTable
          caption="Entrants"
          rows={participants}
          rowKey={(row) => row.id}
          empty="No entrants."
          columns={[
            {
              key: 'user',
              header: 'User',
              render: (row) => (
                <Link href={`/tenants/${tenant.id}/users/${row.userId}`} className="so-link">
                  {row.displayName ?? row.externalId}
                </Link>
              ),
            },
            { key: 'external', header: 'External id', render: (row) => <Mono>{row.externalId}</Mono> },
            { key: 'state', header: 'State', render: (row) => <StateChip value={row.state} /> },
            { key: 'seed', header: 'Seed', numeric: true, render: (row) => row.seed ?? '—' },
            { key: 'team', header: 'Team', render: (row) => row.teamRef ?? '—' },
            { key: 'score', header: 'Score', numeric: true, render: (row) => scoreByUser.get(row.userId)?.score ?? '—' },
            { key: 'finished', header: 'Finished', render: (row) => (scoreByUser.has(row.userId) ? (scoreByUser.get(row.userId)?.attemptFinished ? 'yes' : 'no') : '—') },
            { key: 'joined', header: 'Joined', nowrap: true, render: (row) => formatInstant(row.joinedAt) },
            {
              key: 'entry',
              header: 'Entry',
              render: (row) => (
                <Link href={`/entries/${row.entryJournalEntryId}`} className="so-link so-mono">
                  {row.entryJournalEntryId.slice(-8)}
                </Link>
              ),
            },
          ]}
        />
      </Card>
      {results.length === 0 ? null : (
        <Card title="Results">
          <DataTable
            caption="Results"
            rows={results}
            rowKey={(row) => row.id}
            columns={[
              { key: 'placement', header: 'Place', numeric: true, render: (row) => row.placement },
              { key: 'user', header: 'User', render: (row) => nameByUser.get(row.userId) ?? row.userId },
              { key: 'score', header: 'Score', numeric: true, render: (row) => row.score ?? '—' },
              { key: 'payout', header: 'Payout', numeric: true, render: (row) => <Money amount={row.payoutAmount} asset={contest.asset} /> },
              {
                key: 'entry',
                header: 'Journal',
                render: (row) =>
                  row.payoutJournalEntryId === null ? (
                    '—'
                  ) : (
                    <Link href={`/entries/${row.payoutJournalEntryId}`} className="so-link so-mono">
                      {row.payoutJournalEntryId.slice(-8)}
                    </Link>
                  ),
              },
              { key: 'computed', header: 'Computed', render: (row) => formatInstant(row.computedAt) },
            ]}
          />
        </Card>
      )}
    </>
  );
}
