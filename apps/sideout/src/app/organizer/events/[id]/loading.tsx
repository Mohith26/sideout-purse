import { Skeleton } from '@sideout/ui';

import { FormSkeleton, PageHeadingSkeleton, StatGridSkeleton } from '../../../../components/ui/Skeletons';

export default function EventBuilderLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <PageHeadingSkeleton eyebrow pill />
      <StatGridSkeleton count={4} />
      <div className="surface-raised rounded-card p-4 md:p-5">
        <Skeleton width="4rem" height="0.75rem" />
        <div className="mt-3 flex gap-2">
          <Skeleton width="8rem" height="2.75rem" />
          <Skeleton width="8rem" height="2.75rem" />
        </div>
      </div>
      <FormSkeleton fields={6} button={false} />
    </div>
  );
}
