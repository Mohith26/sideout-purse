import { CourtBoardSkeleton, PageHeadingSkeleton } from '../../../../../components/ui/Skeletons';

export default function BoardLoading() {
  return (
    <div className="space-y-6" data-testid="loading">
      <PageHeadingSkeleton eyebrow pill />
      <CourtBoardSkeleton />
    </div>
  );
}
