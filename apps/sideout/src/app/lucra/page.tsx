import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Mono, Notice } from '@sideout/ui';

import { CORRESPONDENCES, lucraFraming } from '../../server/framing';
import { pageContext } from '../../server/pages';
import { readTreasury, usd } from '../../server/treasury';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Why this exists',
  description: 'Sideout runs on Purse, a competition platform built from scratch to understand the problem Lucra solves.',
};

/**
 * The framing page (`LUCRA_FRAMING`). Off, this route 404s and the navigation does not
 * offer it; the platform is unchanged either way.
 */
export default async function LucraPage() {
  const framing = lucraFraming();
  if (!framing.enabled) notFound();
  const { app } = await pageContext();
  const { position } = await readTreasury(app);

  return (
    <div className="space-y-12">
      <header className="max-w-content-narrow space-y-4">
        <p className="type-label text-text-tertiary">Why this exists</p>
        <h1 className="type-display-l">I rebuilt the hard half</h1>
        <p className="type-body text-text-secondary">
          Sideout is a charity beach volleyball app. It is the easy half, and it is the part you can see. The half underneath it is{' '}
          <strong className="text-text-primary">Purse</strong>: an immutable double-entry ledger, a contest and settlement engine, versioned eligibility
          rules, an embeddable SDK, a webhook dispatcher, an operator console and a fiat rail with custody reconciliation.
        </p>
        <p className="type-body text-text-secondary">
          That is, on purpose, the same shape as the infrastructure{' '}
          <a href={framing.partnerUrl} className="text-volt underline underline-offset-2" rel="noreferrer noopener" target="_blank">
            {framing.partner}
          </a>{' '}
          sells: one SDK a brand drops into an app it already has, with payments, compliance and settlement handled underneath. I built it because the
          only way to have an opinion about that problem is to solve it, and because the interesting parts of it are invisible from the outside.
        </p>
      </header>

      <section className="space-y-4" aria-labelledby="claim">
        <h2 id="claim" className="type-heading">
          What is actually running
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <p className="type-label text-text-tertiary">Ledger invariants</p>
            <p className="type-display-l tabular mt-1 text-text-primary">9</p>
            <p className="type-body mt-2 text-text-secondary">Reconciled every 15 minutes. A failure makes the platform answer 503 and page an operator.</p>
          </Card>
          <Card>
            <p className="type-label text-text-tertiary">Custody, reconciled</p>
            <p className="type-display-l tabular mt-1 text-text-primary">{usd(position.netCustodyUsdCents)}</p>
            <p className="type-body mt-2 text-text-secondary">
              What the rail moved and what the ledger owes, {position.reconciled ? 'agreeing exactly' : 'currently disagreeing'}.{' '}
              <Link href="/money" className="text-volt underline underline-offset-2">
                Follow a dollar
              </Link>
              .
            </p>
          </Card>
          <Card>
            <p className="type-label text-text-tertiary">Separate databases</p>
            <p className="type-display-l tabular mt-1 text-text-primary">2</p>
            <p className="type-body mt-2 text-text-secondary">
              The app and the platform never share one. A test proves each process refuses to load the other&rsquo;s connection string.
            </p>
          </Card>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="map">
        <div className="space-y-2">
          <h2 id="map" className="type-heading">
            Their product, and where it lives here
          </h2>
          <p className="type-body max-w-content-narrow text-text-secondary">
            Every row names a real module. The claim is not that this resembles their product; it is that the module exists, is tested, and can be read.
          </p>
        </div>
        <div className="space-y-3">
          {CORRESPONDENCES.map((row) => (
            <Card key={row.their}>
              <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                <div>
                  <p className="type-label text-text-tertiary">{framing.partner} calls it</p>
                  <p className="type-body mt-1 font-semibold text-text-primary">{row.their}</p>
                </div>
                <div>
                  <p className="type-label text-text-tertiary">Here</p>
                  <p className="type-body mt-1 font-semibold text-text-primary">{row.ours}</p>
                  <p className="type-body mt-2 text-text-secondary">{row.detail}</p>
                  <p className="type-label mt-2 text-text-tertiary">
                    <Mono>{row.where}</Mono>
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="other">
        <h2 id="other" className="type-heading">
          The other build: against their real API
        </h2>
        <Card>
          <p className="type-body text-text-secondary">
            Before replacing it, I integrated it. There is a second, standalone version of Sideout that talks to {framing.partner}&rsquo;s documented REST
            API and Web SDK, with a faithful in-process mock so every flow runs end to end without credentials.
          </p>
          <p className="type-body mt-3 text-text-secondary">
            Porting their <Mono>user-score-by-metadata</Mono> matcher turned up something worth reporting: two of the five worked examples in the published
            documentation contradict the prose specification directly above them — example three&rsquo;s scoring of a fully equal array, and example
            five&rsquo;s partial score for <Mono>summer-league</Mono> against <Mono>summer-tournament</Mono>. Rather than guess, the mock implements both
            readings behind a switch, <Mono>/health</Mono> reports which one is active, and a test asserts every row of the comparison table.
          </p>
          <p className="type-body mt-4 text-text-secondary">
            That build lives at <Mono>github.com/Mohith26/sideout</Mono>; this one, the platform rebuild, at <Mono>github.com/Mohith26/sideout-purse</Mono>.
          </p>
        </Card>
      </section>

      <section className="space-y-3" aria-labelledby="honest">
        <h2 id="honest" className="type-heading">
          What is deliberately not real
        </h2>
        <Notice tone="info" title="Stated plainly, because it is a strength rather than a caveat">
          No real money moves and Purse is not a licensed operator: the contest asset is closed-loop and has no cash value. Identity verification,
          geolocation and risk scoring are provider seams with deterministic implementations behind them, each naming the licensed vendor that would fill
          it. What is real is everything that is actually hard: the append-only ledger enforced by database privileges rather than convention, the
          settlement engine and its frozen preview, idempotency on every mutation, the cross-origin boundary, and nine invariants that fail loudly.
        </Notice>
      </section>
    </div>
  );
}
