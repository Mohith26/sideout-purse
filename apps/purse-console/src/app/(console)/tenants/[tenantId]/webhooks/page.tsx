import type { Metadata } from 'next';
import type { ConsoleEndpointResource, TenantDetailResource } from '@purse/types';

import { PageHead } from '../../../../../components/PageHead';
import { load } from '../../../../../server/api';
import { Endpoints } from './Endpoints';

export const metadata: Metadata = { title: 'Webhook endpoints' };

export default async function EndpointsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [tenant, { endpoints }] = await Promise.all([load<TenantDetailResource>(`/tenants/${tenantId}`, `/tenants/${tenantId}/webhooks`), load<{ endpoints: ConsoleEndpointResource[] }>(`/tenants/${tenantId}/webhooks/endpoints`)]);
  return (
    <>
      <PageHead title="Webhook endpoints" crumbs={[{ label: 'Tenants', href: '/tenants' }, { label: tenant.name, href: `/tenants/${tenant.id}` }, { label: 'Webhooks' }]} lede="A signing secret is shown once, at creation and at rotation; the API keeps it encrypted." />
      <Endpoints tenantId={tenant.id} initial={endpoints} />
    </>
  );
}
