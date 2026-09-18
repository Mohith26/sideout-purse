import Link from 'next/link';
import { Card, DataTable, Money, Mono } from '@sideout/ui';
import { ACCOUNT_KINDS, type AccountResource } from '@purse/types';

import { titleCase } from '../lib/format';
import { StateChip } from './StateChip';

/**
 * The account tree (spec 4.10): every account of a tenant grouped by kind in the spec
 * 4.2.1 order, each group's total shown, every balance derived. Wallets name their user,
 * escrows their contest; the platform accounts are singletons per asset.
 */
export function AccountTree({ accounts }: { accounts: AccountResource[] }) {
  const byKind = new Map<string, AccountResource[]>();
  for (const kind of ACCOUNT_KINDS) byKind.set(kind, []);
  for (const account of accounts) byKind.get(account.kind)?.push(account);
  return (
    <Card title="Accounts">
      <div className="tree">
        {[...byKind].map(([kind, rows]) => {
          const totals = new Map<string, bigint>();
          for (const row of rows) totals.set(row.asset, (totals.get(row.asset) ?? 0n) + BigInt(row.balance));
          return (
            <details key={kind} open={rows.length > 0 && rows.length <= 12}>
              <summary className="tree__kind">
                <span className="tree__kind-name">
                  {titleCase(kind)} <span className="label">({rows.length})</span>
                </span>
                <span className="so-num">
                  {[...totals].map(([asset, total]) => (
                    <span key={asset} style={{ marginLeft: 'var(--space-3)' }}>
                      <Money amount={total} asset={asset} />
                    </span>
                  ))}
                </span>
              </summary>
              <DataTable
                caption={`${titleCase(kind)} accounts`}
                rows={rows}
                rowKey={(row) => row.id}
                empty="No accounts of this kind."
                columns={[
                  {
                    key: 'id',
                    header: 'Account',
                    render: (row) => (
                      <Link href={`/accounts/${row.id}`} className="so-link so-mono">
                        {row.id}
                      </Link>
                    ),
                  },
                  {
                    key: 'owner',
                    header: 'Owner',
                    render: (row) =>
                      row.owner === null ? (
                        <span className="label">platform</span>
                      ) : row.owner.kind === 'user' ? (
                        <Link href={`/tenants/${row.tenantId}/users/${row.owner.id}`} className="so-link">
                          {row.owner.displayName ?? row.owner.externalId} <Mono>{row.owner.externalId}</Mono>
                        </Link>
                      ) : (
                        <Link href={`/tenants/${row.tenantId}/contests/${row.owner.id}`} className="so-link">
                          {row.owner.title} <StateChip value={row.owner.state} />
                        </Link>
                      ),
                  },
                  { key: 'asset', header: 'Asset', render: (row) => row.asset },
                  { key: 'side', header: 'Normal side', render: (row) => row.normalSide },
                  { key: 'status', header: 'Status', render: (row) => <StateChip value={row.status} /> },
                  { key: 'lines', header: 'Lines', numeric: true, render: (row) => row.lineCount },
                  { key: 'balance', header: 'Balance', numeric: true, render: (row) => <Money amount={row.balance} /> },
                ]}
              />
            </details>
          );
        })}
      </div>
    </Card>
  );
}
