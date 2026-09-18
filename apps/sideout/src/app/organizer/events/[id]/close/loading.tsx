import { Skeleton } from '@sideout/ui';

import { CardListSkeleton, PageHeadingSkeleton, SectionHeadingSkeleton } from '../../../../../components/ui/Skeletons';

export default function CloseLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <PageHeadingSkeleton eyebrow pill />
      <div>
        <SectionHeadingSkeleton aside />
        <CardListSkeleton count={2} lines={1} />
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <Skeleton height="4rem" />
      </div>
    </div>
  );
}
