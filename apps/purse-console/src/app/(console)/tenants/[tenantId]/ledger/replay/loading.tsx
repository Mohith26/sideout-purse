import { Card, Skeleton } from '@sideout/ui';

export default function ReplayLoading() {
  return <div className="stack" aria-label="Loading ledger replay">
    <Skeleton height="3rem" />
    {['Journal timeline', 'Conservation at this entry', 'Journal entry', 'Account balances', 'Contest escrows touched so far'].map((title) =>
      <Card key={title} title={title}><Skeleton height="8rem" /></Card>,
    )}
  </div>;
}
