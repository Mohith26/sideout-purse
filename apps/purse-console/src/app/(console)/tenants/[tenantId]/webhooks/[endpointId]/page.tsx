import type { Metadata } from 'next';
import { Card, KeyValue, Mono } from '@sideout/ui';
import { WEBHOOK_DELIVERY_STATUSES, type ConsoleDeliveryResource, type ConsoleEndpointResource, type TenantDetailResource } from '@purse/types';

import { DeliveryTable } from '../../../../../../components/DeliveryTable';
import { PageHead } from '../../../../../../components/PageHead';
import { StateChip } from '../../../../../../components/StateChip';
import { StatusFilter } from '../../../../../../components/StatusFilter';
import { formatInstant } from '../../../../../../lib/format';
import { load } from '../../../../../../server/api';

export const metadata: Metadata = { title: 'Endpoint deliveries' };

export default async function EndpointPage({ params, searchParams }: { params: Promise<{ tenantId: string; endpointId: string }>; searchParams: Promise<{ status?: string }> }) {
  const { tenantId, endpointId } = await params;
  const { status } = await searchParams;
  const filter = WEBHOOK_DELIVERY_STATUSES.find((each) => each === status);
  const path = `/tenants/${tenantId}/webhooks/${endpointId}`;
  const [tenant, endpoint, { deliveries }] = await Promise.all([
    load<TenantDetailResource>(`/tenants/${tenantId}`, path),
    load<ConsoleEndpointResource>(`/tenants/${tenantId}/webhooks/endpoints/${endpointId}`),
    load<{ deliveries: ConsoleDeliveryResource[] }>(`/tenants/${tenantId}/webhooks/endpoints/${endpointId}/deliveries?limit=100${filter === undefined ? '' : `&status=${filter}`}`),
  ]);
  return (
    <>
      <PageHead title="Endpoint" crumbs={[{ label: 'Tenants', href: '/tenants' }, { label: tenant.name, href: `/tenants/${tenant.id}` }, { label: 'Webhooks', href: `/tenants/${tenant.id}/webhooks` }, { label: endpoint.url }]} />
      <Card title="Endpoint">
        <KeyValue
          items={[
            { key: 'URL', value: <Mono>{endpoint.url}</Mono> },
            { key: 'Id', value: <Mono>{endpoint.id}</Mono> },
            { key: 'Status', value: <StateChip value={endpoint.status} /> },
            { key: 'Description', value: endpoint.description ?? '—' },
            { key: 'Events', value: endpoint.subscribedEvents.map((type) => <div key={type}><Mono>{type}</Mono></div>) },
            { key: 'Created', value: formatInstant(endpoint.createdAt) },
          ]}
        />
      </Card>
      <StatusFilter options={WEBHOOK_DELIVERY_STATUSES} current={filter} basePath={path} />
      <DeliveryTable initial={deliveries} />
    </>
  );
}
