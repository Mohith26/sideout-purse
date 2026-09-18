import { CardListSkeleton, DataTableSkeleton, PageHeadingSkeleton } from '../../../components/ui/Skeletons';

export default function OrganizerEventsLoading() {
  return (
    <div className="space-y-6" data-testid="loading">
      <PageHeadingSkeleton />
      <div className="md:hidden">
        <CardListSkeleton count={3} />
      </div>
      <div className="hidden md:block">
        <DataTableSkeleton rows={4} columns={6} />
      </div>
    </div>
  );
}
