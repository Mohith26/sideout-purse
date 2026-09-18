import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, DataTable, KeyValue, Money, Mono } from '@sideout/ui';
import type { AuditRowResource, ConsoleUserResource, TenantDetailResource } from '@purse/types';

import { FlagQueue } from '../../../../../../components/FlagQueue';
import { PageHead } from '../../../../../../components/PageHead';
import { StateChip } from '../../../../../../components/StateChip';
import { formatInstant, titleCase } from '../../../../../../lib/format';
import { load } from '../../../../../../server/api';
import { Restrictions } from './Restrictions';

export const metadata: Metadata = { title: 'User' };

export default async function UserPage({ params }: { params: Promise<{ tenantId: string; userId: string }> }) {
  const { tenantId, userId } = await params;
  const path = `/tenants/${tenantId}/users/${userId}`;
  const [tenant, detail, { audit }] = await Promise.all([load<TenantDetailResource>(`/tenants/${tenantId}`, path), load<ConsoleUserResource>(path), load<{ audit: AuditRowResource[] }>(`/audit?subject=${userId}&limit=50`)]);
  const { user } = detail;
  return (
    <>
      <PageHead title={user.displayName ?? user.externalId} crumbs={[{ label: 'Tenants', href: '/tenants' }, { label: tenant.name, href: `/tenants/${tenant.id}` }, { label: 'Users', href: `/tenants/${tenant.id}/users` }, { label: user.externalId }]} actions={<StateChip value={user.verification.state} />} />
      <div className="grid grid--two">
        <Card title="Identity">
          <KeyValue
            items={[
              { key: 'Id', value: <Mono>{user.id}</Mono> },
              { key: 'External id', value: <Mono>{user.externalId}</Mono> },
              { key: 'Phone', value: user.phoneE164 ?? '—' },
              { key: 'Date of birth', value: user.dateOfBirth ?? '—' },
              { key: 'Verification', value: `${user.verification.state}${user.verification.provider === null ? '' : ` via ${user.verification.provider}`}` },
              { key: 'Verified at', value: formatInstant(user.verification.verifiedAt) },
              { key: 'Region', value: user.location === null ? '—' : `${user.location.regionCode} (${user.location.source}, ${user.location.confidence})` },
              { key: 'Created', value: formatInstant(user.createdAt) },
            ]}
          />
        </Card>
        <Card title="Wallets">
          <DataTable
            rows={detail.wallets}
            rowKey={(row) => row.asset}
            columns={[
              { key: 'asset', header: 'Asset', render: (row) => row.asset },
              { key: 'balance', header: 'Balance', numeric: true, render: (row) => <Money amount={row.balance} /> },
              {
                key: 'account',
                header: 'Account',
                render: (row) =>
                  row.accountId === null ? (
                    'not opened'
                  ) : (
                    <Link href={`/accounts/${row.accountId}`} className="so-link so-mono">
                      {row.accountId}
                    </Link>
                  ),
              },
            ]}
          />
        </Card>
      </div>
      <Restrictions tenantId={tenant.id} userId={user.id} initial={detail.restrictions} />
      {detail.openFlags.length === 0 ? null : (
        <Card title="Open flags">
          <FlagQueue initial={detail.openFlags} />
        </Card>
      )}
      <Card title="Recent eligibility decisions">
        <DataTable
          rows={detail.recentDecisions}
          rowKey={(row) => row.id}
          empty="No entry attempts yet."
          columns={[
            { key: 'at', header: 'At', render: (row) => formatInstant(row.createdAt) },
            {
              key: 'contest',
              header: 'Contest',
              render: (row) => (
                <Link href={`/tenants/${tenant.id}/contests/${row.contestId}`} className="so-link so-mono">
                  {row.contestId.slice(-8)}
                </Link>
              ),
            },
            { key: 'allowed', header: 'Decision', render: (row) => <StateChip value={row.allowed ? 'ok' : 'failed'} /> },
            { key: 'reasons', header: 'Reasons', render: (row) => (row.reasons.length === 0 ? '—' : row.reasons.map(titleCase).join(', ')) },
            { key: 'ruleset', header: 'Ruleset', render: (row) => row.rulesetVersion },
          ]}
        />
      </Card>
      <Card title="Audit trail">
        <DataTable
          rows={audit}
          rowKey={(row) => row.id}
          empty="No audit rows name this user."
          columns={[
            { key: 'at', header: 'At', render: (row) => formatInstant(row.createdAt) },
            { key: 'action', header: 'Action', render: (row) => <Mono>{row.action}</Mono> },
            { key: 'actor', header: 'Actor', render: (row) => `${row.actorKind}${row.actorRef === null ? '' : `:${row.actorRef}`}` },
            { key: 'request', header: 'Request', render: (row) => (row.requestId === null ? '—' : <Mono>{row.requestId}</Mono>) },
          ]}
        />
      </Card>
    </>
  );
}
