import { Icons } from '@sideout/ui';

import { cx } from '../../lib/cx';
import { formatDateTime, formatPoints, ordinal, sumCents } from '../../lib/format';
import { DataTable, type DataTableColumn } from '../ui/DataTable';

/**
 * What the organizer confirms before anything settles (spec 5.3, item 6; 4.7): Purse's
 * placements and payouts exactly as its frozen preview holds them, the escrow they sum to,
 * and the payout hash that `POST …/close` must echo. Contest value is POINTS (decision D3):
 * it is never a donation figure, so ember appears nowhere here.
 */
export type FrozenStandingRow = {
  teamId: string;
  teamName: string;
  placement: number;
  players: Array<{ userId: string; displayName: string; purseUserId: string | null }>;
};

export type FrozenPreviewProps = {
  standings: readonly FrozenStandingRow[];
  payouts: ReadonlyArray<{ userId: string; placement: number; payout: string }>;
  escrowTotal: string;
  payoutHash: string;
  contestState: string;
  asset?: string;
  /** Set once the tournament settled: when and by whom, from the audit. */
  settledAt?: { at: string; timeZone: string } | null;
  className?: string;
};

export function FrozenPreview({ standings, payouts, escrowTotal, payoutHash, contestState, asset = 'POINTS', settledAt = null, className }: FrozenPreviewProps) {
  const payoutFor = (purseUserId: string | null): string | null => (purseUserId === null ? null : (payouts.find((p) => p.userId === purseUserId)?.payout ?? null));
  const total = sumCents(payouts.map((p) => p.payout));
  const columns: Array<DataTableColumn<FrozenStandingRow>> = [
    { key: 'placement', header: '#', numeric: true, width: 'w-12', render: (r) => <span className="tabular font-medium text-text-primary">{ordinal(r.placement)}</span> },
    {
      key: 'team',
      header: 'Team',
      render: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-text-primary">{r.teamName}</span>
          <span className="truncate type-label text-text-tertiary">{r.players.map((p) => p.displayName).join(' & ')}</span>
        </span>
      ),
    },
    {
      key: 'payout',
      header: 'Payout per player',
      numeric: true,
      render: (r) => (
        <span className="tabular text-text-primary">
          {r.players.map((p) => {
            const payout = payoutFor(p.purseUserId);
            return payout === null ? '—' : formatPoints(payout, asset);
          }).join(' / ')}
        </span>
      ),
    },
  ];
  return (
    <div className={cx('space-y-6', className)} data-testid="frozen-preview">
      <section aria-labelledby="frozen-standings-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 id="frozen-standings-heading" className="type-label text-text-tertiary">
            Placements and payouts
          </h3>
          <span className="tabular type-label text-text-tertiary">
            contest {contestState.replace(/_/g, ' ')} · {standings.length} teams
          </span>
        </div>
        <DataTable columns={columns} rows={standings} getRowKey={(r) => r.teamId} caption="Final placements and the payout Purse computed for each player" emptyLabel="No teams to place." />
        <p className="mt-2 text-text-secondary">
          Payouts sum to <span className="tabular text-text-primary">{formatPoints(total, asset)}</span> of <span className="tabular text-text-primary">{formatPoints(escrowTotal, asset)}</span> in escrow.
          {total === escrowTotal ? ' Every unit in escrow is paid out; none is lost to rounding.' : ' The difference stays in escrow until Purse reconciles it.'}
        </p>
      </section>

      <section aria-labelledby="frozen-hash-heading" className="surface-inset rounded-card p-4">
        <h3 id="frozen-hash-heading" className="flex items-center gap-2 type-label text-text-tertiary">
          <Icons.info size={14} />
          {settledAt === null ? 'Payout hash' : 'Frozen preview'}
        </h3>
        <p className="mt-2 text-text-secondary">
          {settledAt === null
            ? 'Closing presents this hash. Purse recomputes the settlement and refuses the close if anything changed since the preview; you then review a fresh one.'
            : 'This is exactly what was confirmed at close. The hash below is what Purse settled against.'}
        </p>
        <code data-testid="payout-hash" className="so-mono mt-2 block rounded-chip bg-bg-base px-2 py-1.5 text-text-primary">
          {payoutHash}
        </code>
        {settledAt === null ? null : <p className="mt-2 tabular type-label text-text-tertiary">Closed {formatDateTime(settledAt.at, settledAt.timeZone)}</p>}
      </section>
    </div>
  );
}
