import { Skeleton } from '@sideout/ui';

import { CardListSkeleton, PageHeadingSkeleton, SectionHeadingSkeleton } from '../../components/ui/Skeletons';

export default function MeLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <div className="surface-raised rounded-card p-5 md:p-6">
        <PageHeadingSkeleton />
      </div>
      <div>
        <SectionHeadingSkeleton />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Skeleton height="6rem" />
          <Skeleton height="6rem" />
        </div>
      </div>
      <div>
        <SectionHeadingSkeleton />
        <CardListSkeleton count={2} lines={2} />
      </div>
    </div>
  );
}
