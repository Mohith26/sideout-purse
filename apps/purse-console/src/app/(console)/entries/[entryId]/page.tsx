import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, DataTable, KeyValue, Money, Mono } from '@sideout/ui';
import type { EntryDetailResource } from '@purse/types';

import { PageHead } from '../../../../components/PageHead';
import { StateChip } from '../../../../components/StateChip';
import { formatInstant, titleCase } from '../../../../lib/format';
import { load } from '../../../../server/api';

export const metadata: Metadata = { title: 'Journal entry' };

/**
 * The entry drill-down (spec 4.10 "showing balanced lines"): every line with its
 * account, the per-asset debit and credit sums that prove rules 1 to 3 held, the contest
 * it belongs to, and the reversal links in both directions.
 */
export default async function EntryPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  const detail = await load<EntryDetailResource>(`/entries/${entryId}`, `/entries/${entryId}`);
  const { entry } = detail;
  return (
    <>
      <PageHead title={`${titleCase(entry.kind)} entry`} crumbs={[{ label: 'Ledger', href: '/ledger' }, { label: 'Journal', href: `/tenants/${entry.tenantId}/ledger` }, { label: entry.id }]} />
      <div className="grid grid--two">
        <Card title="Entry">
          <KeyValue
            items={[
              { key: 'Id', value: <Mono>{entry.id}</Mono> },
              { key: 'Kind', value: entry.kind },
              { key: 'Description', value: entry.description },
              { key: 'Posted', value: formatInstant(entry.postedAt) },
              { key: 'Created', value: formatInstant(entry.createdAt) },
              { key: 'Idempotency key', value: <Mono>{entry.idempotencyKey}</Mono> },
              {
                key: 'Contest',
                value:
                  detail.contest === null ? (
                    '—'
                  ) : (
                    <Link href={`/tenants/${entry.tenantId}/contests/${detail.contest.id}`} className="so-link">
                      {detail.contest.title} <StateChip value={detail.contest.state} />
                    </Link>
                  ),
              },
              {
                key: 'Reverses',
                value:
                  detail.reverses === null ? (
                    '—'
                  ) : (
                    <Link href={`/entries/${detail.reverses.id}`} className="so-link so-mono">
                      {detail.reverses.id}
                    </Link>
                  ),
              },
              {
                key: 'Reversed by',
                value:
                  detail.reversedBy === null ? (
                    'not reversed'
                  ) : (
                    <Link href={`/entries/${detail.reversedBy.id}`} className="so-link so-mono">
                      {detail.reversedBy.id}
                    </Link>
                  ),
              },
            ]}
          />
        </Card>
        <Card title="Balance check">
          <p className="console__lede">Spec 4.2.2 rules 1 to 3, re-derived from the rows: two or more lines, one asset, debits equal credits.</p>
          <DataTable
            caption="Per-asset totals"
            rows={detail.totals}
            rowKey={(row) => row.asset}
            columns={[
              { key: 'asset', header: 'Asset', render: (row) => row.asset },
              { key: 'debits', header: 'Debits', numeric: true, render: (row) => <Money amount={row.debits} /> },
              { key: 'credits', header: 'Credits', numeric: true, render: (row) => <Money amount={row.credits} /> },
              { key: 'balanced', header: 'Balanced', render: (row) => <StateChip value={row.balanced ? 'ok' : 'failed'} /> },
            ]}
          />
          <p className={`balanced ${detail.balanced ? 'balanced--ok' : 'balanced--broken'}`} data-testid="entry-balanced">
            {detail.balanced ? `Balanced: ${detail.lines.length} lines net to zero.` : 'NOT BALANCED: this entry violates the journal rules.'}
          </p>
        </Card>
      </div>
      <Card title="Lines">
        <DataTable
          caption="Journal lines"
          rows={detail.lines}
          rowKey={(row) => row.line.id}
          columns={[
            { key: 'seq', header: '#', numeric: true, render: (row) => row.line.sequence },
            {
              key: 'account',
              header: 'Account',
              render: (row) => (
                <Link href={`/accounts/${row.account.id}`} className="so-link so-mono">
                  {row.account.id}
                </Link>
              ),
            },
            { key: 'kind', header: 'Kind', render: (row) => titleCase(row.account.kind) },
            {
              key: 'owner',
              header: 'Owner',
              render: (row) => (row.account.owner === null ? <span className="label">platform</span> : row.account.owner.kind === 'user' ? (row.account.owner.displayName ?? row.account.owner.externalId) : row.account.owner.title),
            },
            { key: 'direction', header: 'Side', render: (row) => row.line.direction },
            { key: 'amount', header: 'Amount', numeric: true, render: (row) => <Money amount={row.line.amount} asset={row.line.asset} /> },
            { key: 'delta', header: 'Effect on account', numeric: true, render: (row) => <Money amount={row.delta} signed /> },
          ]}
        />
      </Card>
    </>
  );
}
