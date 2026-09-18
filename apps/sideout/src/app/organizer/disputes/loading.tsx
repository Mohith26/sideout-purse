import { CardListSkeleton, PageHeadingSkeleton } from '../../../components/ui/Skeletons';

export default function DisputesLoading() {
  return (
    <div className="space-y-6" data-testid="loading">
      <PageHeadingSkeleton />
      <CardListSkeleton count={2} lines={3} />
    </div>
  );
}
