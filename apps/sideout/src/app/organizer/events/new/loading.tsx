import { FormSkeleton, PageHeadingSkeleton } from '../../../../components/ui/Skeletons';

export default function NewEventLoading() {
  return (
    <div className="space-y-6" data-testid="loading">
      <PageHeadingSkeleton eyebrow />
      <FormSkeleton fields={6} />
    </div>
  );
}
