import type { Metadata } from 'next';
import { OPERATOR_FLAG_KINDS, OPERATOR_FLAG_STATUSES, type OperatorFlagResource } from '@purse/types';

import { FlagQueue } from '../../../components/FlagQueue';
import { PageHead } from '../../../components/PageHead';
import { StatusFilter } from '../../../components/StatusFilter';
import { load } from '../../../server/api';

export const metadata: Metadata = { title: 'Review queue' };

/** The review queues (spec 4.6, 4.10): duplicate-identity flags, collusion signals and risk reviews, open by default. */
export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ status?: string; kind?: string }> }) {
  const { status, kind } = await searchParams;
  const statusFilter = status === 'all' ? undefined : (OPERATOR_FLAG_STATUSES.find((each) => each === status) ?? 'open');
  const kindFilter = OPERATOR_FLAG_KINDS.find((each) => each === kind);
  const query = new URLSearchParams({ limit: '100' });
  if (statusFilter !== undefined) query.set('status', statusFilter);
  if (kindFilter !== undefined) query.set('kind', kindFilter);
  const { flags } = await load<{ flags: OperatorFlagResource[] }>(`/flags?${query.toString()}`, '/review');
  return (
    <>
      <PageHead title="Review queue" lede="What the risk controls surfaced for a human: flagged, never auto-blocked. Resolve or dismiss each once; a restriction is placed from the user's page." />
      <div className="stack" style={{ gap: 'var(--space-2)' }}>
        <StatusFilter options={OPERATOR_FLAG_STATUSES} current={statusFilter} basePath="/review" param="status" extra={{ status: 'all', ...(kindFilter === undefined ? {} : { kind: kindFilter }) }} />
        <StatusFilter options={OPERATOR_FLAG_KINDS} current={kindFilter} basePath="/review" param="kind" extra={statusFilter === undefined ? { status: 'all' } : { status: statusFilter }} />
      </div>
      <FlagQueue initial={flags} />
    </>
  );
}
