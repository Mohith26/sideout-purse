import type { Metadata } from 'next';
import type { LedgerReplayResource } from '@purse/types';

import { LedgerReplay } from '../../../../../../components/LedgerReplay';
import { PageHead } from '../../../../../../components/PageHead';
import { load } from '../../../../../../server/api';

export const metadata: Metadata = { title: 'Ledger replay' };

export default async function ReplayPage({ params, searchParams }: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ at?: string; position?: string; after?: string }>;
}) {
  const { tenantId } = await params;
  const query = await searchParams;
  const search = new URLSearchParams();
  if (query.at !== undefined) search.set('at', query.at);
  if (query.position !== undefined) search.set('position', query.position);
  if (query.after !== undefined) search.set('after', query.after);
  const initial = await load<LedgerReplayResource>(`/tenants/${tenantId}/ledger/replay?${search}`);
  return <>
    <PageHead title="Ledger replay" crumbs={[{ label: 'Ledger', href: `/tenants/${tenantId}/ledger` }, { label: 'Replay' }]}
      lede="Rebuild the ledger one posting at a time. Every balance is derived from the append-only journal." />
    <LedgerReplay key={`${tenantId}:${initial.entry?.id ?? 'empty'}:${query.after ?? ''}`} tenantId={tenantId} initial={initial} />
  </>;
}
