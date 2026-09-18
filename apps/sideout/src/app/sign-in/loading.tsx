import { FormSkeleton, PageHeadingSkeleton } from '../../components/ui/Skeletons';

export default function SignInLoading() {
  return (
    <div className="mx-auto max-w-md space-y-6" data-testid="loading">
      <PageHeadingSkeleton />
      <FormSkeleton fields={1} />
    </div>
  );
}
