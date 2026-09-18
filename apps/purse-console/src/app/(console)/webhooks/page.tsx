import type { Metadata } from 'next';
import { WEBHOOK_DELIVERY_STATUSES, type ConsoleDeliveryResource } from '@purse/types';

import { DeliveryTable } from '../../../components/DeliveryTable';
import { PageHead } from '../../../components/PageHead';
import { StatusFilter } from '../../../components/StatusFilter';
import { load } from '../../../server/api';

export const metadata: Metadata = { title: 'Deliveries' };

/** The delivery log across every tenant, newest first, by status. */
export default async function DeliveriesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = WEBHOOK_DELIVERY_STATUSES.find((each) => each === status);
  const { deliveries } = await load<{ deliveries: ConsoleDeliveryResource[] }>(`/webhooks/deliveries?limit=100${filter === undefined ? '' : `&status=${filter}`}`, '/webhooks');
  return (
    <>
      <PageHead title="Deliveries" lede="Every webhook delivery on the platform with its attempts. Replay queues the same event to the same endpoint as a new delivery." />
      <StatusFilter options={WEBHOOK_DELIVERY_STATUSES} current={filter} basePath="/webhooks" />
      <DeliveryTable initial={deliveries} showTenant />
    </>
  );
}
