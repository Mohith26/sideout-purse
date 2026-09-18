'use client';

import Link from 'next/link';
import { ActionButton, EmptyState, Icons } from '@sideout/ui';

import { formatPoints, ordinal } from '../../lib/format';
import { DataTable, type DataTableColumn } from '../ui/DataTable';
import { usePurse } from './PurseGate';

/** A reward row as `server/rewards.ts` produces it. */
export type RewardView = { tournamentId: string; tournamentSlug: string; tournamentName: string; teamName: string; placement: number; payout: string | null; settledAt: string };

const columns: Array<DataTableColumn<RewardView>> = [
  {
    key: 'event',
    header: 'Event',
    render: (r) => (
      <Link href={`/t/${r.tournamentSlug}/impact`} className="target -my-2.5 flex items-center py-2.5 font-medium text-text-primary hover:text-volt">
        {r.tournamentName}
      </Link>
    ),
  },
  { key: 'place', header: 'Place', numeric: true, render: (r) => ordinal(r.placement) },
  { key: 'team', header: 'Team', hideBelowMd: true, render: (r) => <span className="text-text-secondary">{r.teamName}</span> },
  { key: 'payout', header: 'Payout', numeric: true, render: (r) => (r.payout === null ? <span className="text-text-tertiary">No entry</span> : <span className="text-text-primary">{formatPoints(r.payout, 'POINTS')}</span>) },
];

/** Rewards as Purse settled them (spec 5.3, "Profile"), with Purse's own rewards flow one button away. */
export function RewardsPanel({ rewards }: { rewards: readonly RewardView[] }) {
  const purse = usePurse();
  const linked = purse.profile.kind === 'ready' && purse.profile.profile.linked;
  return (
    <div className="space-y-3" data-testid="rewards-panel">
      {linked && purse.config !== null ? (
        <ActionButton variant="secondary" disabled={purse.busy} onClick={() => void purse.open('rewards')} iconStart={<Icons.gift size={16} />}>
          Open rewards in Purse
        </ActionButton>
      ) : null}
      {rewards.length === 0 ? (
        <EmptyState icon="gift" title="No rewards yet" body="Rewards are paid in POINTS by placement when an event settles through Purse. They are separate from donations." />
      ) : (
        <DataTable columns={columns} rows={rewards} getRowKey={(r) => r.tournamentId} caption="Rewards Purse settled for your teams" />
      )}
    </div>
  );
}
