import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable } from '@sideout/ui';
import type { TenantResource } from '@purse/types';

import { PageHead } from '../../../components/PageHead';
import { StateChip } from '../../../components/StateChip';
import { load } from '../../../server/api';

export const metadata: Metadata = { title: 'Ledger explorer' };

/** The ledger is per tenant: pick one to open its account tree and journal. */
export default async function LedgerPage() {
  const { tenants } = await load<{ tenants: TenantResource[] }>('/tenants', '/ledger');
  return (
    <>
      <PageHead title="Ledger explorer" lede="Every balance on these pages is derived from the journal at the moment you look; nothing is stored or cached. Pick a tenant." />
      <DataTable
        caption="Tenants"
        rows={tenants}
        rowKey={(row) => row.id}
        empty="No tenants yet."
        columns={[
          {
            key: 'name',
            header: 'Tenant',
            render: (row) => (
              <Link href={`/tenants/${row.id}/ledger`} className="so-link">
                {row.name}
              </Link>
            ),
          },
          { key: 'status', header: 'Status', render: (row) => <StateChip value={row.status} /> },
          { key: 'users', header: 'Users', numeric: true, render: (row) => row.counts.users },
          { key: 'contests', header: 'Contests', numeric: true, render: (row) => row.counts.contests },
        ]}
      />
    </>
  );
}
