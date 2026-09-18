import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, KeyValue, Mono } from '@sideout/ui';
import type { ApiKeyResource, ConsoleMeResource, TenantDetailResource } from '@purse/types';

import { PageHead } from '../../../../components/PageHead';
import { StateChip } from '../../../../components/StateChip';
import { formatInstant } from '../../../../lib/format';
import { load } from '../../../../server/api';
import { ApiKeys } from './ApiKeys';
import { TenantStatus } from './TenantStatus';

export const metadata: Metadata = { title: 'Tenant' };

export default async function TenantPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [tenant, keys, me] = await Promise.all([
    load<TenantDetailResource>(`/tenants/${tenantId}`, `/tenants/${tenantId}`),
    load<{ apiKeys: ApiKeyResource[] }>(`/tenants/${tenantId}/api-keys`),
    load<ConsoleMeResource>('/auth/me'),
  ]);
  const admin = me.operator.role === 'admin';
  return (
    <>
      <PageHead
        title={tenant.name}
        crumbs={[{ label: 'Tenants', href: '/tenants' }, { label: tenant.name }]}
        actions={
          <>
            <Link href={`/tenants/${tenant.id}/webhooks`} className="so-button so-button--secondary so-button--small">
              Webhooks
            </Link>
            <Link href={`/tenants/${tenant.id}/users`} className="so-button so-button--secondary so-button--small">
              Users
            </Link>
            <Link href={`/contests?tenantId=${tenant.id}`} className="so-button so-button--secondary so-button--small">
              Contests
            </Link>
            <Link href={`/tenants/${tenant.id}/ledger`} className="so-button so-button--secondary so-button--small">
              Ledger
            </Link>
          </>
        }
      />
      <div className="grid grid--two">
        <Card title="Tenant">
          <KeyValue
            items={[
              { key: 'Id', value: <Mono>{tenant.id}</Mono> },
              { key: 'Status', value: <StateChip value={tenant.status} /> },
              { key: 'Created', value: formatInstant(tenant.createdAt) },
              { key: 'Updated', value: formatInstant(tenant.updatedAt) },
              { key: 'Users', value: tenant.counts.users },
              { key: 'Contests', value: tenant.counts.contests },
              { key: 'Origins', value: tenant.origins.length === 0 ? '—' : tenant.origins.map((origin) => <div key={origin}><Mono>{origin}</Mono></div>) },
            ]}
          />
          <TenantStatus tenantId={tenant.id} status={tenant.status} admin={admin} />
        </Card>
        <ApiKeys tenantId={tenant.id} initial={keys.apiKeys} admin={admin} />
      </div>
    </>
  );
}
