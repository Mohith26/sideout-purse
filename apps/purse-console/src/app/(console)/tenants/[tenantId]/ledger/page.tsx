import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, DataTable, Money, Mono } from '@sideout/ui';
import { JOURNAL_ENTRY_KINDS, type AccountResource, type EntrySummaryResource, type PageResource, type TenantDetailResource } from '@purse/types';

import { AccountTree } from '../../../../../components/AccountTree';
import { PageHead } from '../../../../../components/PageHead';
import { StatusFilter } from '../../../../../components/StatusFilter';
import { formatInstant, shortId } from '../../../../../lib/format';
import { load } from '../../../../../server/api';

export const metadata: Metadata = { title: 'Ledger' };

/** A tenant's ledger: the account tree by kind with derived balances, and its journal newest first. */
export default async function TenantLedgerPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ kind?: string; contestId?: string; cursor?: string }> }) {
  const { tenantId } = await params;
  const { kind, contestId, cursor } = await searchParams;
  const kindFilter = JOURNAL_ENTRY_KINDS.find((each) => each === kind);
  const query = new URLSearchParams({ limit: '50' });
  if (kindFilter !== undefined) query.set('kind', kindFilter);
  if (contestId !== undefined && /^cnt_[0-9a-f-]{36}$/.test(contestId)) query.set('contestId', contestId);
  if (cursor !== undefined && /^\d{1,15}:je_[0-9a-f-]{36}$/.test(cursor)) query.set('cursor', cursor);
  const path = `/tenants/${tenantId}/ledger`;
  const [tenant, { accounts }, page] = await Promise.all([
    load<TenantDetailResource>(`/tenants/${tenantId}`, path),
    load<{ accounts: AccountResource[] }>(`/tenants/${tenantId}/accounts`),
    load<PageResource<EntrySummaryResource>>(`/tenants/${tenantId}/entries?${query.toString()}`),
  ]);
  const extra: Record<string, string> = query.has('contestId') ? { contestId: query.get('contestId') ?? '' } : {};
  const nextQuery = new URLSearchParams(extra);
  if (kindFilter !== undefined) nextQuery.set('kind', kindFilter);
  if (page.nextCursor !== null) nextQuery.set('cursor', page.nextCursor);
  return (
    <>
      <PageHead title="Ledger" crumbs={[{ label: 'Ledger', href: '/ledger' }, { label: tenant.name, href: `/tenants/${tenant.id}` }, { label: 'Accounts and journal' }]} lede="Balances are the signed sum of each account's lines relative to its normal side, computed now. Open an account for its history and a point-in-time balance; open an entry to see its lines balance." />
      <AccountTree accounts={accounts} />
      <Card title={query.has('contestId') ? 'Journal (one contest)' : 'Journal'}>
        <StatusFilter options={JOURNAL_ENTRY_KINDS} current={kindFilter} basePath={path} param="kind" extra={extra} />
        <DataTable
          caption="Journal entries"
          rows={page.items}
          rowKey={(row) => row.entry.id}
          empty="No entries."
          columns={[
            { key: 'posted', header: 'Posted', nowrap: true, render: (row) => formatInstant(row.entry.postedAt) },
            {
              key: 'id',
              header: 'Entry',
              nowrap: true,
              render: (row) => (
                <Link href={`/entries/${row.entry.id}`} className="so-link so-mono" title={row.entry.id}>
                  {shortId(row.entry.id)}
                </Link>
              ),
            },
            { key: 'kind', header: 'Kind', render: (row) => row.entry.kind },
            { key: 'description', header: 'Description', render: (row) => row.entry.description },
            { key: 'amount', header: 'Moved', numeric: true, render: (row) => <Money amount={row.amount} asset={row.asset ?? undefined} /> },
            { key: 'lines', header: 'Lines', numeric: true, render: (row) => row.lineCount },
            {
              key: 'contest',
              header: 'Contest',
              render: (row) =>
                row.entry.contestId === null ? (
                  '—'
                ) : (
                  <Link href={`/tenants/${tenant.id}/contests/${row.entry.contestId}`} className="so-link so-mono">
                    {row.entry.contestId.slice(-8)}
                  </Link>
                ),
            },
            { key: 'reverses', header: 'Reverses', render: (row) => (row.entry.reversesEntryId === null ? '—' : <Link href={`/entries/${row.entry.reversesEntryId}`} className="so-link so-mono">{row.entry.reversesEntryId.slice(-8)}</Link>) },
            { key: 'key', header: 'Idempotency key', render: (row) => <Mono>{row.entry.idempotencyKey}</Mono> },
          ]}
        />
        {page.nextCursor === null ? null : (
          <div>
            <Link href={`${path}?${nextQuery.toString()}`} className="so-button so-button--secondary so-button--small">
              Older entries
            </Link>
          </div>
        )}
      </Card>
    </>
  );
}
