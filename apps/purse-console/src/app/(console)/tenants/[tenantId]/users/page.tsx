import type { Metadata } from 'next';
import Link from 'next/link';
import { Button, DataTable, Field, Input, Mono } from '@sideout/ui';
import type { TenantDetailResource, UserSummaryResource } from '@purse/types';

import { PageHead } from '../../../../../components/PageHead';
import { StateChip } from '../../../../../components/StateChip';
import { formatInstant } from '../../../../../lib/format';
import { load } from '../../../../../server/api';

export const metadata: Metadata = { title: 'Users' };

export default async function UsersPage({ params, searchParams }: { params: Promise<{ tenantId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { tenantId } = await params;
  const { q = '' } = await searchParams;
  const query = new URLSearchParams({ limit: '100' });
  if (q.trim() !== '') query.set('q', q.trim());
  const [tenant, { users }] = await Promise.all([load<TenantDetailResource>(`/tenants/${tenantId}`, `/tenants/${tenantId}/users`), load<{ users: UserSummaryResource[] }>(`/tenants/${tenantId}/users?${query.toString()}`)]);
  return (
    <>
      <PageHead title="Users" crumbs={[{ label: 'Tenants', href: '/tenants' }, { label: tenant.name, href: `/tenants/${tenant.id}` }, { label: 'Users' }]} />
      <form method="get" className="filters">
        <Field id="user-q" label="Find" hint="Id, the partner's external id, name or phone.">
          <Input id="user-q" name="q" defaultValue={q} maxLength={200} />
        </Field>
        <Button type="submit">Search</Button>
      </form>
      <DataTable
        caption="Users"
        rows={users}
        rowKey={(row) => row.id}
        empty="No users match."
        columns={[
          {
            key: 'name',
            header: 'User',
            render: (row) => (
              <Link href={`/tenants/${tenant.id}/users/${row.id}`} className="so-link">
                {row.displayName ?? row.externalId}
              </Link>
            ),
          },
          { key: 'external', header: 'External id', render: (row) => <Mono>{row.externalId}</Mono> },
          { key: 'id', header: 'Id', render: (row) => <Mono>{row.id}</Mono> },
          { key: 'phone', header: 'Phone', render: (row) => row.phoneE164 ?? '—' },
          { key: 'verification', header: 'Verification', render: (row) => <StateChip value={row.verificationState} /> },
          { key: 'created', header: 'Created', nowrap: true, render: (row) => formatInstant(row.createdAt) },
        ]}
      />
    </>
  );
}
