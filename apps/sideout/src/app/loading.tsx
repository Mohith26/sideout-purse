import { MatchCardSkeleton, TournamentCardSkeleton } from '../components/ui/Skeletons';

export default function HomeLoading() {
  return (
    <div className="space-y-10" data-testid="loading">
      <div className="flex gap-3 overflow-hidden">
        <MatchCardSkeleton />
        <MatchCardSkeleton />
        <MatchCardSkeleton />
      </div>
      <TournamentCardSkeleton featured />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TournamentCardSkeleton />
        <TournamentCardSkeleton />
      </div>
    </div>
  );
}
