import { cx } from '../../lib/cx';
import { compareCents, formatCents, formatPercent, percentOf, subtractCents, type Cents } from '../../lib/format';

/**
 * Raised versus goal. `--ember` is the charity colour and appears nowhere else. The bar
 * caps at 100% visually; the label does not, so a met goal reads as what it is. Every
 * figure is integer arithmetic on cents.
 */
export type ImpactMeterProps = {
  raisedCents: Cents;
  goalCents: Cents;
  currency: string;
  donorCount?: number;
  variant?: 'compact' | 'full';
  className?: string;
};

export function ImpactMeter({ raisedCents, goalCents, currency, donorCount, variant = 'full', className }: ImpactMeterProps) {
  const percent = percentOf(raisedCents, goalCents);
  const met = compareCents(raisedCents, goalCents) >= 0 && BigInt(goalCents) > 0n;
  const raisedText = formatCents(raisedCents, currency);
  const goalText = formatCents(goalCents, currency);
  return (
    <div className={className} data-testid="impact-meter">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          {variant === 'full' ? <div className="type-label text-text-tertiary">Raised for the beneficiary</div> : null}
          <div className={cx('tabular text-ember', variant === 'full' ? 'type-display-l' : 'type-heading')}>{raisedText}</div>
        </div>
        <div className="text-end text-text-secondary">
          <div className="tabular">
            <span className="text-text-primary">{formatPercent(percent)}</span> of {goalText}
          </div>
          {variant === 'full' && donorCount !== undefined ? (
            <div className="type-label mt-0.5 text-text-tertiary">
              <span className="tabular">{donorCount}</span> {donorCount === 1 ? 'gift' : 'gifts'}
            </div>
          ) : null}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Fundraising progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${raisedText} of ${goalText}`}
        className={cx('mt-3 w-full overflow-hidden rounded-pill bg-bg-inset', variant === 'full' ? 'h-2.5' : 'h-2')}
      >
        <div className="h-full rounded-pill bg-ember" style={{ width: `${percent}%` }} />
      </div>
      {variant === 'full' ? (
        <div className="mt-2 flex items-center justify-between type-label text-text-tertiary">
          <span>{met ? 'Goal met' : 'Toward goal'}</span>
          <span className="tabular">{met ? `+${formatCents(subtractCents(raisedCents, goalCents), currency)} over` : `${formatCents(subtractCents(goalCents, raisedCents), currency)} to go`}</span>
        </div>
      ) : null}
    </div>
  );
}
