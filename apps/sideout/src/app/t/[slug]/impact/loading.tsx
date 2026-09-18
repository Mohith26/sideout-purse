import { Skeleton } from '@sideout/ui';

import { DataTableSkeleton, SectionHeadingSkeleton, StatGridSkeleton } from '../../../../components/ui/Skeletons';

export default function ImpactTabLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <div className="surface-raised rounded-card p-5 md:p-6">
        <Skeleton width="6rem" height="0.75rem" />
        <Skeleton width="14rem" height="1.5rem" style={{ marginTop: '0.5rem' }} />
        <Skeleton height="1rem" style={{ marginTop: '0.75rem' }} />
      </div>
      <div>
        <Skeleton width="8rem" height="2rem" />
        <Skeleton height="0.625rem" pill style={{ marginTop: '0.75rem' }} />
        <div className="mt-5">
          <StatGridSkeleton count={4} />
        </div>
      </div>
      <div>
        <SectionHeadingSkeleton />
        <DataTableSkeleton rows={5} columns={4} />
      </div>
    </div>
  );
}
