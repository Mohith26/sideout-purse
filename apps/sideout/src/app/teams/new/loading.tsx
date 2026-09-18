import { FormSkeleton, PageHeadingSkeleton } from '../../../components/ui/Skeletons';

export default function NewTeamLoading() {
  return (
    <div className="mx-auto max-w-md space-y-6" data-testid="loading">
      <PageHeadingSkeleton eyebrow />
      <FormSkeleton fields={2} />
    </div>
  );
}
