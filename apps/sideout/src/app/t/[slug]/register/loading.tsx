import { Skeleton } from '@sideout/ui';

export default function RegisterLoading() {
  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="loading">
      <Skeleton width="16rem" height="1rem" />
      {[1, 2].map((n) => (
        <div key={n} className="surface-raised rounded-card p-4 md:p-5">
          <div className="flex items-start gap-4">
            <Skeleton width="2.25rem" height="2.25rem" pill />
            <div className="flex-1 space-y-3">
              <Skeleton width="12rem" height="1.25rem" />
              <Skeleton height="1rem" />
              <Skeleton width="75%" height="1rem" />
              <Skeleton height="3rem" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
