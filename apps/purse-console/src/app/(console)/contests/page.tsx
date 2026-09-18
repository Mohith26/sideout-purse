import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable, Money, Mono } from '@sideout/ui';
import { CONTEST_STATES, type ContestSummaryResource, type TenantResource } from '@purse/types';

import { PageHead } from '../../../components/PageHead';
import { StateChip } from '../../../components/StateChip';
import { StatusFilter } from '../../../components/StatusFilter';
import { formatInstant } from '../../../lib/format';
import { load } from '../../../server/api';

export const metadata: Metadata = { title: 'Contests' };

/** The contest browser (spec 4.10): every tenant's contests by state, escrow balance and entrant count derived from the journal. */
export default async function ContestsPage({ searchParams }: { searchParams: Promise<{ state?: string; tenantId?: string }> }) {
  const { state, tenantId } = await searchParams;
  const filter = CONTEST_STATES.find((each) => each === state);
  const query = new URLSearchParams({ limit: '100' });
  if (filter !== undefined) query.set('state', filter);
  if (tenantId !== undefined && /^tnt_[0-9a-f-]{36}$/.test(tenantId)) query.set('tenantId', tenantId);
  const [{ contests }, { tenants }] = await Promise.all([load<{ contests: ContestSummaryResource[] }>(`/contests?${query.toString()}`, '/contests'), load<{ tenants: TenantResource[] }>('/tenants')]);
  const tenant = tenants.find((each) => each.id === query.get('tenantId'));
  return (
    <>
      <PageHead title="Contests" lede={tenant === undefined ? 'Every contest on the platform. An operator_close contest in awaiting settlement is closed from its page.' : `Contests of ${tenant.name}.`} />
      <StatusFilter options={CONTEST_STATES} current={filter} basePath="/contests" param="state" extra={tenant === undefined ? {} : { tenantId: tenant.id }} />
      <DataTable
        caption="Contests"
        rows={contests}
        rowKey={(row) => row.id}
        empty="No contests match."
        columns={[
          {
            key: 'title',
            header: 'Contest',
            render: (row) => (
              <Link href={`/tenants/${row.tenantId}/contests/${row.id}`} className="so-link">
                {row.title}
              </Link>
            ),
          },
          { key: 'tenant', header: 'Tenant', render: (row) => row.tenantName },
          { key: 'external', header: 'External id', render: (row) => <Mono>{row.externalId}</Mono> },
          { key: 'state', header: 'State', render: (row) => <StateChip value={row.state} /> },
          { key: 'policy', header: 'Settlement', render: (row) => row.settlementPolicy },
          { key: 'entry', header: 'Entry', numeric: true, render: (row) => <Money amount={row.entryAmount} asset={row.asset} /> },
          { key: 'entrants', header: 'Entrants', numeric: true, render: (row) => row.participantCount },
          { key: 'escrow', header: 'Escrow', numeric: true, render: (row) => <Money amount={row.escrowBalance} asset={row.asset} /> },
          { key: 'created', header: 'Created', nowrap: true, render: (row) => formatInstant(row.createdAt) },
        ]}
      />
    </>
  );
}
