import { Card, Mono } from '@sideout/ui';

import type { ParsedPayment } from '../../purse';
import { PAYMENT_STATE_COPY, usd } from '../../server/treasury';

/**
 * One payment, told as the sequence of things that happened to it.
 *
 * The rows are `payment_events`, which are append-only in Postgres: the runtime role holds
 * `SELECT, INSERT` on that table and nothing else, so this is not a reconstruction of the
 * story, it is the story as it was written down at the time.
 */
export function MoneyTrail({ payment }: { payment: ParsedPayment }) {
  const events = payment.events ?? [];
  return (
    <ol className="relative ml-3 border-l border-border-subtle pl-6">
      {events.map((event, index) => {
        const copy = PAYMENT_STATE_COPY[event.toState];
        const last = index === events.length - 1;
        return (
          <li key={event.id} className="relative pb-6 last:pb-0">
            <span
              aria-hidden
              className={`absolute -left-[31px] top-1 grid h-3 w-3 place-items-center rounded-full ring-4 ring-bg-base ${
                copy?.tone === 'negative' ? 'bg-fault' : copy?.tone === 'positive' ? 'bg-surf' : 'bg-text-tertiary'
              }`}
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="type-body font-semibold text-text-primary">{copy?.label ?? event.toState}</span>
              <span className="type-label text-text-tertiary">
                by {event.actor}
                {last ? ' · latest' : ''}
              </span>
            </div>
            <p className="type-body mt-1 text-text-secondary">{copy?.meaning ?? 'A step in the payment.'}</p>
            {event.detail['note'] !== undefined && typeof event.detail['note'] === 'string' ? (
              <p className="type-body mt-1 text-text-tertiary">{event.detail['note']}</p>
            ) : null}
            {typeof event.detail['journalEntryId'] === 'string' ? (
              <p className="type-label mt-1 text-text-tertiary">
                Ledger entry <Mono>{event.detail['journalEntryId']}</Mono>
              </p>
            ) : null}
          </li>
        );
      })}
      {events.length === 0 ? <li className="type-label text-text-tertiary">No recorded steps.</li> : null}
    </ol>
  );
}

/**
 * Where a single entry fee ends up, as arithmetic the reader can check.
 *
 * Every number here is derived from the two the contest actually recorded, so a reader can
 * add them up. That is the whole argument: the rake is not a percentage quoted in
 * marketing copy, it is a journal entry, and the payouts are what is left.
 */
export function PotSplit({ gross, rakeBps }: { gross: bigint; rakeBps: number }) {
  const rake = rakeBps <= 0 ? 0n : (gross * BigInt(rakeBps)) / 10_000n;
  const net = gross - rake;
  const rakeShare = gross === 0n ? 0 : Number((rake * 1000n) / gross) / 10;
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-4">
        <span className="type-label text-text-tertiary">The pot</span>
        <span className="type-display-l tabular text-text-primary">{usd(gross)}</span>
      </div>
      <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-bg-overlay" role="img" aria-label={`${rakeShare}% platform fee, the rest to players`}>
        <span className="bg-volt" style={{ width: `${100 - rakeShare}%` }} />
        <span className="bg-ember" style={{ width: `${rakeShare}%` }} />
      </div>
      <dl className="mt-4 space-y-2">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="type-body text-text-secondary">
            <span aria-hidden className="mr-2 inline-block h-2 w-2 rounded-full bg-volt align-middle" />
            To the players
          </dt>
          <dd className="type-body font-semibold tabular text-text-primary">{usd(net)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="type-body text-text-secondary">
            <span aria-hidden className="mr-2 inline-block h-2 w-2 rounded-full bg-ember align-middle" />
            Platform fee, {(rakeBps / 100).toFixed(2)}%
          </dt>
          <dd className="type-body font-semibold tabular text-text-primary">{usd(rake)}</dd>
        </div>
      </dl>
      <p className="type-body mt-4 text-text-secondary">
        The fee is its own journal entry, posted before the settlement, so the settlement only ever distributes the net pool. Rounding is down, so the
        remainder stays with the players rather than being created out of nothing.
      </p>
    </Card>
  );
}
