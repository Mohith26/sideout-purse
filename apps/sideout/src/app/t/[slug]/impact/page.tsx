import { EmptyState, Icons } from '@sideout/ui';

import { DonorWall } from '../../../../components/tournament/DonorWall';
import { ImpactMeter } from '../../../../components/tournament/ImpactMeter';
import { SponsorTiers } from '../../../../components/tournament/SponsorRow';
import { Stat } from '../../../../components/ui/Stat';
import { formatCents, subtractCents } from '../../../../lib/format';
import { tournamentImpactDetail } from '../../../../server/impact';
import { tournamentPage } from '../_lib';

export const dynamic = 'force-dynamic';

/** Impact tab (spec 5.3): beneficiary story, raised vs goal, donor wall, sponsor tiers. Every figure sums `donations` rows. */
export default async function ImpactTab({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { app, row, summary } = await tournamentPage(slug);
  const t = summary.tournament;
  const impact = await tournamentImpactDetail(app.db, row.tournament);
  const { breakdown } = impact;

  return (
    <div className="space-y-10">
      <section aria-labelledby="story-heading" className="surface-raised rounded-card p-5 md:p-6">
        <h2 id="story-heading" className="type-label text-text-tertiary">
          Beneficiary
        </h2>
        <p className="type-heading mt-1">{t.beneficiary.name}</p>
        {t.beneficiary.description === null ? null : <p className="mt-2 max-w-prose text-text-secondary">{t.beneficiary.description}</p>}
        {t.beneficiary.websiteUrl === null ? null : (
          <a href={t.beneficiary.websiteUrl} target="_blank" rel="noreferrer noopener" className="target mt-3 inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt">
            Visit their site
            <Icons.externalLink size={14} />
          </a>
        )}
      </section>

      <section aria-labelledby="raised-heading">
        <h2 id="raised-heading" className="sr-only">
          Raised versus goal
        </h2>
        <ImpactMeter raisedCents={breakdown.raisedCents} goalCents={breakdown.goalCents} currency={breakdown.currency} donorCount={breakdown.donorCount} />
        <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Team entries" value={formatCents(breakdown.entryCents, breakdown.currency)} hint={`${breakdown.entryCount} teams`} tone="ember" />
          <Stat label="Supporter gifts" value={formatCents(breakdown.supporterCents, breakdown.currency)} hint={`${breakdown.supporterCount} gifts`} tone="ember" />
          <Stat label="Pending" value={formatCents(breakdown.pendingCents, breakdown.currency)} hint="Not yet counted" />
          <Stat label="Goal" value={formatCents(breakdown.goalCents, breakdown.currency)} hint={breakdown.progressPercent >= 100 ? 'Met' : `${formatCents(subtractCents(breakdown.goalCents, breakdown.raisedCents), breakdown.currency)} to go`} />
        </dl>
      </section>

      <section aria-labelledby="donors-heading">
        <h2 id="donors-heading" className="type-label mb-3 text-text-tertiary">
          Donor wall · <span className="tabular">{impact.donorWall.length}</span>
        </h2>
        {impact.donorWall.length === 0 ? <EmptyState icon="heartHandshake" title="No gifts yet" body="Team entries and supporter gifts appear here as they complete." /> : <DonorWall rows={impact.donorWall} timeZone={t.venue.timezone} />}
      </section>

      <section aria-labelledby="sponsors-heading">
        <h2 id="sponsors-heading" className="type-label mb-3 text-text-tertiary">
          Sponsor tiers
        </h2>
        {impact.sponsors.length === 0 ? <EmptyState icon="handCoins" title="No sponsors yet" /> : <SponsorTiers sponsors={impact.sponsors} currency={breakdown.currency} />}
        <p className="mt-3 type-label text-text-tertiary">
          Sponsor contributions (<span className="tabular">{formatCents(impact.sponsorPrizeCents, breakdown.currency)}</span>) shape the POINTS prize split in Purse. They are a separate ledger from donations and are never counted toward the goal.
        </p>
      </section>
    </div>
  );
}
