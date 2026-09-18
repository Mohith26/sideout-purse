import { SectionHeadingSkeleton, StandingsSkeleton } from '../../../../components/ui/Skeletons';

export default function StandingsLoading() {
  return (
    <div data-testid="loading">
      <SectionHeadingSkeleton aside />
      <StandingsSkeleton />
    </div>
  );
}
