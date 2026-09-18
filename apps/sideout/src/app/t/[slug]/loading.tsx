import { Skeleton } from '@sideout/ui';

import { DataTableSkeleton, SectionHeadingSkeleton, StatGridSkeleton } from '../../../components/ui/Skeletons';

export default function TournamentLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <StatGridSkeleton count={6} />
      <div>
        <SectionHeadingSkeleton />
        <DataTableSkeleton rows={4} columns={5} />
      </div>
      <div className="surface-raised rounded-card p-5 md:p-6">
        <Skeleton width="10rem" height="0.75rem" />
        <Skeleton width="8rem" height="2rem" style={{ marginTop: '0.75rem' }} />
        <Skeleton height="0.625rem" pill style={{ marginTop: '0.75rem' }} />
      </div>
    </div>
  );
}
