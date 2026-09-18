import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable, Mono } from '@sideout/ui';
import type { TenantResource } from '@purse/types';

import { PageHead } from '../../../components/PageHead';
import { StateChip } from '../../../components/StateChip';
import { formatInstant } from '../../../lib/format';
import { load } from '../../../server/api';

export const metadata: Metadata = { title: 'Tenants' };

export default async function TenantsPage() {
  const { tenants } = await load<{ tenants: TenantResource[] }>('/tenants', '/tenants');
  return (
    <>
      <PageHead title="Tenants" lede="Every partner on the platform. A suspended tenant's keys stop authenticating at once." />
      <DataTable
        caption="Tenants"
        rows={tenants}
        rowKey={(row) => row.id}
        empty="No tenants yet; run pnpm db:seed."
        columns={[
          {
            key: 'name',
            header: 'Tenant',
            render: (row) => (
              <Link href={`/tenants/${row.id}`} className="so-link">
                {row.name}
              </Link>
            ),
          },
          { key: 'id', header: 'Id', render: (row) => <Mono>{row.id}</Mono> },
          { key: 'status', header: 'Status', render: (row) => <StateChip value={row.status} /> },
          { key: 'keys', header: 'Keys', numeric: true, render: (row) => row.counts.apiKeys },
          { key: 'users', header: 'Users', numeric: true, render: (row) => row.counts.users },
          { key: 'contests', header: 'Contests', numeric: true, render: (row) => row.counts.contests },
          { key: 'endpoints', header: 'Endpoints', numeric: true, render: (row) => row.counts.webhookEndpoints },
          { key: 'created', header: 'Created', nowrap: true, render: (row) => formatInstant(row.createdAt) },
        ]}
      />
    </>
  );
}
