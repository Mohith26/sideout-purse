import { BracketSkeleton, DataTableSkeleton, SectionHeadingSkeleton } from '../../../../components/ui/Skeletons';

export default function BracketLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <div>
        <SectionHeadingSkeleton aside />
        <BracketSkeleton />
      </div>
      <div>
        <SectionHeadingSkeleton aside />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DataTableSkeleton rows={4} columns={6} />
          <DataTableSkeleton rows={4} columns={6} />
        </div>
      </div>
    </div>
  );
}
