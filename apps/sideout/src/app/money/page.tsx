import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, Mono, Notice, StatusPill } from '@sideout/ui';

import { MoneyTrail, PotSplit } from '../../components/money/MoneyTrail';
import { lucraFraming } from '../../server/framing';
import { pageContext } from '../../server/pages';
import {
  declinedPayment,
  inFlightWithdrawal,
  PAYMENT_STATE_COPY,
  readPayment,
  readTreasury,
  usd,
  walkthroughPayment,
} from '../../server/treasury';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Money',
  description: 'Where an entry fee goes: the fiat rail, the ledger, the rake and the payout, with the live numbers behind each step.',
};

/**
 * "Follow a dollar" (spec section 13).
 *
 * The argument this page makes is that the money path is auditable end to end, so every
 * figure on it is read live from Purse rather than written into the copy. It walks one real
 * deposit from a card to a wallet to an escrow to a payout, shows the custody
 * reconciliation that proves the two halves agree, and shows the payment that failed,
 * because a money page on which everything succeeded is not evidence of anything.
 */
export default async function MoneyPage() {
  const { app } = await pageContext();
  const framing = lucraFraming();
  const snapshot = await readTreasury(app);
  const { position, capabilities, payments } = snapshot;

  const headline = walkthroughPayment(payments);
  const walkthrough = headline === null ? null : await readPayment(app, headline.id);
  const declined = declinedPayment(payments);
  const inFlight = inFlightWithdrawal(payments);

  const deposited = BigInt(position.depositedUsdCents);
  const withdrawn = BigInt(position.withdrawnUsdCents);
  const custody = BigInt(position.netCustodyUsdCents);
  const ledger = BigInt(position.ledgerCustodyCredit);
  const rake = BigInt(position.platformFeeCredit);
  const railFees = BigInt(position.railFeesUsdCents);

  return (
    <div className="space-y-12">
      <header className="max-w-content-narrow space-y-4">
        <p className="type-label text-text-tertiary">Money</p>
        <h1 className="type-display-l">Follow a dollar</h1>
        <p className="type-body text-text-secondary">
          Entry fees on Sideout are held, split and paid out by <strong className="text-text-primary">Purse</strong>, the competition platform underneath it.
          This page walks one real payment from a card through to a payout, and shows the arithmetic that has to hold at every step.
          {framing.enabled ? (
            <>
              {' '}
              It is the part of the system that {framing.partner} calls{' '}
              <Link href="/lucra" className="text-volt underline underline-offset-2">
                security and payments infrastructure
              </Link>
              .
            </>
          ) : null}
        </p>
      </header>

      {snapshot.unavailable !== null ? (
        <Notice tone="warning" title="The rail is not readable right now">
          {snapshot.unavailable}
        </Notice>
      ) : null}

      {/* ---- The custody reconciliation ------------------------------------------------ */}
      <section className="space-y-4" aria-labelledby="custody">
        <div className="space-y-2">
          <h2 id="custody" className="type-heading">
            What is actually held
          </h2>
          <p className="type-body max-w-content-narrow text-text-secondary">
            Two independent descriptions of the same money. The rail knows what it moved; the ledger knows what players are owed. An invariant compares
            them every fifteen minutes and takes the platform to a failing health check if they ever disagree.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Deposited" value={usd(deposited)} note="Every funded deposit, gross." />
          <Figure label="Withdrawn" value={usd(withdrawn)} note="Every funded withdrawal." />
          <Figure label="Held in custody" value={usd(custody)} note="Deposited less withdrawn." emphasis />
          <Figure label="Ledger says owed" value={usd(ledger)} note="The external settlement account." emphasis />
        </div>
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill
              spec={
                position.reconciled
                  ? { label: 'I8 holds', tone: 'success' as const, icon: 'check' as const }
                  : { label: 'I8 is failing', tone: 'attention' as const, icon: 'triangleAlert' as const }
              }
            />
            <p className="type-body text-text-secondary">
              {position.reconciled
                ? `Custody and the ledger agree exactly, to the cent, across every payment that has funded.`
                : `Custody and the ledger disagree. Purse answers 503 on /health while this is true, which is what pages an operator.`}
            </p>
          </div>
          <p className="type-body mt-4 text-text-secondary">
            There is no account of currency <Mono>USD</Mono> anywhere in Purse, and the database cannot express one. Dollars sit in custody at the
            payment provider; the ledger records each player&rsquo;s claim on them in <Mono>CREDIT</Mono>, one unit to one cent. A test asserts that the
            asset enum has exactly two values and that even the database owner is refused a <Mono>USD</Mono> account. That is the compliance boundary
            written as something that runs.
          </p>
        </Card>
      </section>

      {/* ---- The walkthrough ------------------------------------------------------------ */}
      {walkthrough !== null ? (
        <section className="space-y-4" aria-labelledby="walkthrough">
          <div className="space-y-2">
            <h2 id="walkthrough" className="type-heading">
              One payment, step by step
            </h2>
            <p className="type-body max-w-content-narrow text-text-secondary">
              {usd(walkthrough.amountUsdCents)} moving across the rail. Each step below is a row written when it happened, in a table the application can
              insert into and cannot update or delete.
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <Card>
              <MoneyTrail payment={walkthrough} />
            </Card>
            <div className="space-y-4">
              <Card>
                <dl className="space-y-3">
                  <Row label="Payment" value={<Mono>{walkthrough.id}</Mono>} />
                  <Row label="Moved" value={usd(walkthrough.amountUsdCents)} />
                  <Row label="Rail fee" value={usd(walkthrough.feeUsdCents)} />
                  <Row label="Credited to wallet" value={usd(walkthrough.amountUsdCents)} />
                  <Row label="Ledger entry" value={walkthrough.journalEntryId === null ? '—' : <Mono>{walkthrough.journalEntryId}</Mono>} />
                  <Row label="Descriptor" value={walkthrough.statementDescriptor} />
                </dl>
              </Card>
              <Notice tone="info" title="The fee is the platform's, not the player's">
                The rail charges {usd(walkthrough.feeUsdCents)} to move {usd(walkthrough.amountUsdCents)}. The wallet is credited the full amount and the
                processing cost is absorbed, which is both what a merchant of record does and the only version that leaves the custody check a clean
                equality.
              </Notice>
            </div>
          </div>
        </section>
      ) : null}

      {/* ---- The split ----------------------------------------------------------------- */}
      <section className="space-y-4" aria-labelledby="split">
        <div className="space-y-2">
          <h2 id="split" className="type-heading">
            Where an entry fee goes
          </h2>
          <p className="type-body max-w-content-narrow text-text-secondary">
            A cash contest takes its rake off the top, as a separate journal entry posted immediately before settlement. Everything left is divided by the
            prize structure. Because the fee is its own entry, the settlement can only ever distribute the net pool, and the two invariants that check
            settlement arithmetic did not have to be weakened to allow it.
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <PotSplit gross={10_000n} rakeBps={500} />
          <div className="space-y-4">
            <Card>
              <div className="flex items-baseline justify-between gap-4">
                <span className="type-label text-text-tertiary">Rake taken, all time</span>
                <span className="type-display-l tabular text-text-primary">{usd(rake)}</span>
              </div>
              <p className="type-body mt-3 text-text-secondary">
                The platform fee account&rsquo;s balance. An invariant proves it equals the sum of every fee entry that credited it, and that each of
                those debited its own contest&rsquo;s escrow and no one else&rsquo;s.
              </p>
            </Card>
            <Card>
              <div className="flex items-baseline justify-between gap-4">
                <span className="type-label text-text-tertiary">Paid to the rail</span>
                <span className="type-display-l tabular text-text-primary">{usd(railFees)}</span>
              </div>
              <p className="type-body mt-3 text-text-secondary">
                Interchange and processing, a cost rather than revenue. Cards run at 2.9% plus 30&cent;; a bank debit is a flat 80&cent;, which is why the
                instrument a player chooses changes what the platform keeps.
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* ---- The paths that are not the happy one -------------------------------------- */}
      <section className="space-y-4" aria-labelledby="edges">
        <div className="space-y-2">
          <h2 id="edges" className="type-heading">
            The paths that are not the happy one
          </h2>
          <p className="type-body max-w-content-narrow text-text-secondary">
            A payments layer is only worth anything for what it does when something goes wrong. These are live rows, not illustrations.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {declined !== null ? (
            <Card>
              <StatusPill spec={{ label: PAYMENT_STATE_COPY[declined.state]?.label ?? declined.state, tone: 'attention', icon: 'triangleAlert' }} />
              <h3 className="type-subheading mt-3">A charge the rail refused</h3>
              <p className="type-body mt-2 text-text-secondary">
                {usd(declined.amountUsdCents)} declined as <Mono>{declined.failureCode ?? 'declined'}</Mono>. The payment row exists, its trail records
                both steps, and nothing touched the ledger: a payment that never funded carries no journal entry, and the database enforces that pairing
                rather than trusting the service to remember.
              </p>
            </Card>
          ) : null}
          {inFlight !== null ? (
            <Card>
              <StatusPill spec={{ label: PAYMENT_STATE_COPY[inFlight.state]?.label ?? inFlight.state, tone: 'muted', icon: 'clock' }} />
              <h3 className="type-subheading mt-3">A withdrawal still in the air</h3>
              <p className="type-body mt-2 text-text-secondary">
                {usd(inFlight.amountUsdCents)} approved and on its way. The claim left the wallet at approval, before the cash moved, because that is when
                the player stopped being owed it. ACH takes about {capabilities.withdrawalSettlementHours} hours to confirm, and only then does this
                become <em>paid</em>.
              </p>
            </Card>
          ) : null}
        </div>
      </section>

      {/* ---- What the rail accepts ------------------------------------------------------ */}
      <section className="space-y-4" aria-labelledby="rail">
        <div className="space-y-2">
          <h2 id="rail" className="type-heading">
            What the rail accepts
          </h2>
          <p className="type-body max-w-content-narrow text-text-secondary">
            Read from the provider seam at request time, so the interface cannot drift from what the rail will actually do.
          </p>
        </div>
        <Card>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <Row label="Provider" value={capabilities.provider} />
            <Row label="Instruments" value={capabilities.brands.length === 0 ? '—' : capabilities.brands.map(prettyBrand).join(', ')} />
            <Row label="Minimum deposit" value={usd(capabilities.minimumDepositUsdCents)} />
            <Row label="Maximum deposit" value={usd(capabilities.maximumDepositUsdCents)} />
            <Row label="Minimum withdrawal" value={usd(capabilities.minimumWithdrawalUsdCents)} />
            <Row label="Payout time" value={`about ${capabilities.withdrawalSettlementHours} hours`} />
          </dl>
          {capabilities.unsupported.length > 0 ? (
            <div className="mt-6 border-t border-border-subtle pt-4">
              <p className="type-label text-text-tertiary">Refused on purpose</p>
              <ul className="mt-2 space-y-1">
                {capabilities.unsupported.map((entry) => (
                  <li key={entry.brand} className="type-body text-text-secondary">
                    <span className="font-semibold text-text-primary">{prettyBrand(entry.brand)}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
              <p className="type-body mt-3 text-text-secondary">
                A brand that is merely missing from an enum fails as a validation error nobody can act on. These are present, refused, and carry a reason
                a player can be shown; the database refuses them too, so the rule survives a bug in the service.
              </p>
            </div>
          ) : null}
        </Card>
      </section>

      <section className="space-y-3" aria-labelledby="not-real">
        <h2 id="not-real" className="type-heading">
          What is deliberately not real
        </h2>
        <Notice tone="info" title="No money actually moves here">
          Purse is not a licensed operator and this demo is not processing payments. The rail is a provider seam with a deterministic implementation
          behind it, in the same pattern as the identity, geolocation and risk seams: the state machine, the ledger, the fee arithmetic and the
          reconciliation are real and tested, and the vendor behind the interface is named rather than pretended at. The competition asset is closed-loop
          and has no cash value.
        </Notice>
      </section>
    </div>
  );
}

function Figure({ label, value, note, emphasis = false }: { label: string; value: string; note: string; emphasis?: boolean }) {
  return (
    <Card>
      <p className="type-label text-text-tertiary">{label}</p>
      <p className={`type-display-l tabular mt-1 ${emphasis ? 'text-volt' : 'text-text-primary'}`}>{value}</p>
      <p className="type-label mt-2 text-text-tertiary">{note}</p>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="type-label text-text-tertiary">{label}</dt>
      <dd className="type-body text-right text-text-primary">{value}</dd>
    </div>
  );
}

const BRAND_NAMES: Readonly<Record<string, string>> = {
  bank_account: 'Bank account',
  apple_pay: 'Apple Pay',
  amex: 'American Express',
  paypal: 'PayPal',
};

function prettyBrand(brand: string): string {
  return BRAND_NAMES[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}
