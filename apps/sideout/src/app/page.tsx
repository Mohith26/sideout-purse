import { database } from '../db/client';
import { homeSnapshot } from '../home/snapshot';

// Live-first: the page reflects the state of play at request time, never a cached build.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const snapshot = await homeSnapshot(database().db);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="live-heading" className="flex flex-col gap-3">
        <h1 id="live-heading" className="display text-display-l text-text-primary">
          State of play
        </h1>
      </section>

      <section aria-labelledby="upcoming-heading" className="flex flex-col gap-3">
        <h2 id="upcoming-heading" className="label">
          Upcoming
        </h2>
        <div className="rounded-card border border-border-subtle bg-bg-raised p-6">
          <p className="text-heading font-semibold text-text-primary">No events yet</p>
          <p className="mt-2 max-w-prose text-body text-text-secondary">
            The first Sideout tournament has not been scheduled. When it is, it opens here with its
            beneficiary, pool and bracket.
          </p>
        </div>
      </section>

      <section aria-labelledby="impact-heading" className="flex flex-col gap-3">
        <h2 id="impact-heading" className="label">
          Impact
        </h2>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Beneficiaries onboard" value={snapshot.activeCharities} />
        </dl>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border-subtle bg-bg-raised p-4">
      <dt className="label">{label}</dt>
      <dd className="display tabular mt-2 text-display-l text-text-primary">{value}</dd>
    </div>
  );
}
