import { PageHeadingSkeleton, TournamentCardSkeleton } from '../../components/ui/Skeletons';

export default function EventsLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <PageHeadingSkeleton subline={false} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TournamentCardSkeleton />
        <TournamentCardSkeleton />
        <TournamentCardSkeleton />
        <TournamentCardSkeleton />
      </div>
    </div>
  );
}
