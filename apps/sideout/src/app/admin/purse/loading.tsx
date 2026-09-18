import { DataTableSkeleton, PageHeadingSkeleton } from '../../../components/ui/Skeletons';

export default function AdminPurseLoading() {
  return (
    <div className="space-y-6" data-testid="loading">
      <PageHeadingSkeleton />
      <DataTableSkeleton rows={8} columns={6} />
    </div>
  );
}
