import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, DataTable, KeyValue, Money, Mono } from '@sideout/ui';
import type { AccountDetailResource, AccountEntryResource, PageResource } from '@purse/types';

import { AsOfPicker } from '../../../../components/AsOfPicker';
import { PageHead } from '../../../../components/PageHead';
import { StateChip } from '../../../../components/StateChip';
import { formatInstant, shortId, titleCase } from '../../../../lib/format';
import { load } from '../../../../server/api';

export const metadata: Metadata = { title: 'Account' };

/**
 * One account: its derived balance now, its balance as of any instant (`balanceOf(asOf)`,
 * the same query bounded on `posted_at`), and every entry that touched it with the
 * running balance after each.
 */
export default async function AccountPage({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<{ asOf?: string; cursor?: string }> }) {
  const { accountId } = await params;
  const { asOf, cursor } = await searchParams;
  const path = `/accounts/${accountId}`;
  const asOfIso = asOf !== undefined && !Number.isNaN(Date.parse(asOf)) ? new Date(asOf).toISOString() : undefined;
  const query = new URLSearchParams({ limit: '50' });
  if (cursor !== undefined && /^\d{1,15}:je_[0-9a-f-]{36}$/.test(cursor)) query.set('cursor', cursor);
  const [account, page] = await Promise.all([
    load<AccountDetailResource>(`/accounts/${accountId}${asOfIso === undefined ? '' : `?asOf=${encodeURIComponent(asOfIso)}`}`, path),
    load<PageResource<AccountEntryResource>>(`/accounts/${accountId}/entries?${query.toString()}`),
  ]);
  const owner =
    account.owner === null ? (
      <span className="label">platform account</span>
    ) : account.owner.kind === 'user' ? (
      <Link href={`/tenants/${account.tenantId}/users/${account.owner.id}`} className="so-link">
        {account.owner.displayName ?? account.owner.externalId}
      </Link>
    ) : (
      <Link href={`/tenants/${account.tenantId}/contests/${account.owner.id}`} className="so-link">
        {account.owner.title}
      </Link>
    );
  return (
    <>
      <PageHead title={titleCase(account.kind)} crumbs={[{ label: 'Ledger', href: '/ledger' }, { label: 'Accounts', href: `/tenants/${account.tenantId}/ledger` }, { label: account.id }]} actions={<StateChip value={account.status} />} />
      <div className="grid grid--two">
        <Card title="Account">
          <KeyValue
            items={[
              { key: 'Id', value: <Mono>{account.id}</Mono> },
              { key: 'Owner', value: owner },
              { key: 'Asset', value: account.asset },
              { key: 'Normal side', value: account.normalSide },
              { key: 'Lines', value: account.lineCount },
              { key: 'First posting', value: formatInstant(account.firstPostedAt) },
              { key: 'Last posting', value: formatInstant(account.lastPostedAt) },
              { key: 'Opened', value: formatInstant(account.createdAt) },
            ]}
          />
        </Card>
        <Card title="Balance">
          <div className="grid grid--stats">
            <div className="so-stat">
              <span className="so-stat__value" data-testid="balance-now">
                <Money amount={account.balance} asset={account.asset} />
              </span>
              <span className="label">Now</span>
            </div>
            {account.asOf === null ? null : (
              <div className="so-stat">
                <span className="so-stat__value" data-testid="balance-as-of">
                  <Money amount={account.asOf.balance} asset={account.asset} />
                </span>
                <span className="label">As of {formatInstant(account.asOf.at)}</span>
              </div>
            )}
          </div>
          <AsOfPicker path={path} current={asOfIso} />
        </Card>
      </div>
      <Card title="Entries">
        <DataTable
          caption="Entries touching this account"
          rows={page.items}
          rowKey={(row) => row.line.id}
          empty="Nothing has posted to this account."
          columns={[
            { key: 'posted', header: 'Posted', nowrap: true, render: (row) => formatInstant(row.entry.postedAt) },
            {
              key: 'entry',
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
            { key: 'direction', header: 'Side', render: (row) => row.line.direction },
            { key: 'delta', header: 'Change', numeric: true, render: (row) => <Money amount={row.delta} signed /> },
            { key: 'after', header: 'Balance after', numeric: true, render: (row) => <Money amount={row.balanceAfter} /> },
          ]}
        />
        {page.nextCursor === null ? null : (
          <div>
            <Link href={`${path}?${new URLSearchParams({ ...(asOfIso === undefined ? {} : { asOf: asOfIso }), cursor: page.nextCursor }).toString()}`} className="so-button so-button--secondary so-button--small">
              Older entries
            </Link>
          </div>
        )}
      </Card>
    </>
  );
}
