import { Skeleton } from '@sideout/ui';

import { DataTableSkeleton, PageHeadingSkeleton } from '../../components/ui/Skeletons';

export default function ImpactLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <PageHeadingSkeleton />
      <div className="surface-raised rounded-card p-5 md:p-6">
        <Skeleton width="6rem" height="0.75rem" />
        <Skeleton width="16rem" height="1.5rem" style={{ marginTop: '0.5rem' }} />
        <Skeleton height="1rem" style={{ marginTop: '0.75rem' }} />
        <Skeleton height="0.625rem" pill style={{ marginTop: '1.5rem' }} />
      </div>
      <DataTableSkeleton rows={3} columns={5} />
    </div>
  );
}
