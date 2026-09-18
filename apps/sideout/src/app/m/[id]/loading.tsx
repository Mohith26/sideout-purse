import { Skeleton } from '@sideout/ui';

import { PageHeadingSkeleton } from '../../../components/ui/Skeletons';

export default function MatchLoading() {
  return (
    <div className="space-y-8" data-testid="loading">
      <PageHeadingSkeleton eyebrow pill />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Skeleton height="4.5rem" />
        <Skeleton height="4.5rem" />
      </div>
      <div className="surface-raised rounded-card p-4 md:p-5">
        <Skeleton width="4rem" height="0.75rem" />
        <Skeleton width="12rem" height="3rem" style={{ marginTop: '0.75rem' }} />
      </div>
      <Skeleton height="3rem" />
    </div>
  );
}
