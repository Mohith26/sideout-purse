import type { SponsorTier } from '../../db/schema';
import { cx } from '../../lib/cx';
import { formatCents } from '../../lib/format';
import { SPONSOR_TIER_LABEL, SPONSOR_TIER_ORDER } from '../status/labels';

export type SponsorLike = { id: string; name: string; tier: SponsorTier; prizeContributionCents: string; logoUrl: string | null };

/** Sponsors as text wordmarks with their tier, in tier order; logos are optional and never stock art. */
export function SponsorRow({ sponsors, showContribution = false, currency = 'USD', className }: { sponsors: readonly SponsorLike[]; showContribution?: boolean; currency?: string; className?: string }) {
  if (sponsors.length === 0) return null;
  const ordered = [...sponsors].sort((x, y) => SPONSOR_TIER_ORDER.indexOf(x.tier) - SPONSOR_TIER_ORDER.indexOf(y.tier));
  return (
    <ul className={cx('flex flex-wrap gap-2', className)} data-testid="sponsor-row">
      {ordered.map((s) => (
        <li key={s.id} className="surface-raised flex min-h-11 items-center gap-3 rounded-input px-3 py-2">
          <span className="font-medium text-text-primary">{s.name}</span>
          <span className="type-label text-text-tertiary">{SPONSOR_TIER_LABEL[s.tier]}</span>
          {showContribution && BigInt(s.prizeContributionCents) > 0n ? <span className="tabular type-label text-text-secondary">{formatCents(s.prizeContributionCents, currency)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The sponsor tiers as three cards: who is in each and what they put up for the prize pool. */
export function SponsorTiers({ sponsors, currency = 'USD' }: { sponsors: readonly SponsorLike[]; currency?: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="sponsor-tiers">
      {SPONSOR_TIER_ORDER.map((tier) => {
        const inTier = sponsors.filter((s) => s.tier === tier);
        return (
          <div key={tier} className="surface-raised rounded-card p-4">
            <h3 className="type-label text-text-tertiary">{SPONSOR_TIER_LABEL[tier]}</h3>
            {inTier.length === 0 ? (
              <p className="mt-2 text-text-tertiary">Open</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {inTier.map((s) => (
                  <li key={s.id} className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-text-primary">{s.name}</span>
                    <span className="tabular type-label text-text-secondary">{formatCents(s.prizeContributionCents, currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
