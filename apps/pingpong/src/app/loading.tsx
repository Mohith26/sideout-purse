import { Skeleton } from '@sideout/ui';

export default function Loading() {
  return (
    <div className="flex flex-col gap-4 py-6" aria-busy="true" aria-label="Loading">
      <Skeleton width="40%" height="2rem" />
      <Skeleton width="100%" height="6rem" />
      <Skeleton width="100%" height="12rem" />
    </div>
  );
}
