import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icons, LinkButton, StatusPill } from '@sideout/ui';

import { cx } from '../../lib/cx';
import { formatCents, formatTime } from '../../lib/format';
import { maskPhone } from '../../lib/phone';
import { DONATION_STATUS_PILL } from '../status/pills';
import { Notice } from '../ui/Notice';
import { RegisterButton } from './RegisterButton';
import { ResumePayment } from './ResumePayment';
import { donationStep, type RegistrationState } from './state';

/**
 * The two registration steps (spec 5.3, "Register"), deliberately unalike so a donation
 * is never mistaken for a stake:
 *
 * 1. Charitable donation: the ember accent, the beneficiary's name, and copy that says
 *    "donation". Stripe's Payment Element in stripe mode; the dev provider's honest
 *    pending → received in development.
 * 2. Contest entry on Purse: a volt-bordered surface that, once the team holds its place,
 *    holds the Purse entry step: each player's own entry in Purse's frame, read back from
 *    the contest so the page is never trusted. Before that it is locked and says so.
 */
export type RegistrationStepsProps = {
  slug: string;
  tournamentName: string;
  charityName: string;
  entryDonationCents: string;
  currency: string;
  timeZone: string;
  state: RegistrationState;
  teamId: string | null;
  teamName: string | null;
  stripePublishableKey: string | null;
  /** Step 2's live content once the team is registered (`PurseEntryStep`), else null. */
  entry?: ReactNode;
};

function StepCard({ number, title, tone, status, children }: { number: number; title: string; tone: 'ember' | 'purse'; status: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`step-${number}-heading`} data-testid={`register-step-${number}`} className={cx('rounded-card', tone === 'ember' ? 'surface-raised border-t-2 border-t-ember' : 'border border-volt/40 bg-bg-overlay')}>
      <div className="flex items-start gap-4 p-4 md:p-5">
        <span aria-hidden="true" className={cx('tabular flex size-9 shrink-0 items-center justify-center rounded-pill type-label', tone === 'ember' ? 'bg-ember/15 text-ember' : 'bg-bg-inset text-volt')}>
          {number}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`step-${number}-heading`} className="type-subheading">
              <span className="sr-only">Step {number}: </span>
              {title}
            </h2>
            {status}
          </div>
          <div className="mt-3 space-y-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function RegistrationSteps({ slug, tournamentName, charityName, entryDonationCents, currency, timeZone, state, teamId, teamName, stripePublishableKey, entry = null }: RegistrationStepsProps) {
  const step1 = donationStep(state, entryDonationCents);
  const amount = formatCents(entryDonationCents, currency);
  const donation = state.kind === 'registered' || state.kind === 'lapsed' ? state.donation : null;
  const canRegister = (state.kind === 'ready' || state.kind === 'lapsed') && state.isCaptain && teamId !== null;

  return (
    <div className="space-y-4">
      <StepCard number={1} title="Charitable donation" tone="ember" status={donation === null ? step1 === 'free' ? <span className="type-label text-text-tertiary">No entry fee</span> : null : <StatusPill spec={DONATION_STATUS_PILL[donation.status]} size="sm" />}>
        <p className="text-text-secondary">
          Entry to {tournamentName} is a <span className="tabular font-medium text-ember">{amount}</span> donation to <span className="text-text-primary">{charityName}</span>. It goes to the beneficiary through Stripe; it is
          not a stake and it never touches the contest.
        </p>

        {state.kind === 'no_team' ? (
          <Notice tone="info" title="Create a team first">
            Registration is per team of two. Name the team and invite your partner by phone; come back here once they have accepted.
          </Notice>
        ) : null}
        {state.kind === 'waiting_partner' ? (
          <Notice tone="info" title="Waiting for your partner">
            {state.invitedPhone === null ? (
              'This step unlocks once both players are on the team.'
            ) : (
              <>
                The invite went to <span className="tabular text-text-primary">{maskPhone(state.invitedPhone)}</span>. When they sign in with that number and accept, this step unlocks.
              </>
            )}
          </Notice>
        ) : null}
        {state.kind === 'closed' ? (
          <Notice tone="attention" title="Registration is closed">
            {tournamentName} is no longer taking entries.
          </Notice>
        ) : null}
        {state.kind === 'ready' && state.full ? (
          <Notice tone="attention" title="The event is full">
            Every place is taken right now. Registering will only succeed if one opens.
          </Notice>
        ) : null}
        {state.kind === 'ready' && !state.isCaptain ? (
          <Notice tone="info" title="Your captain registers the team">
            Only the captain can make the entry donation. Once they have, the Purse entry below opens for both of you.
          </Notice>
        ) : null}
        {state.kind === 'lapsed' ? (
          <Notice tone="attention" title="Your reservation lapsed">
            The place was held for a while without a payment landing. {state.isCaptain ? 'Register again to hold it for a fresh payment.' : 'Your captain can register again.'}
          </Notice>
        ) : null}
        {step1 === 'processing' && donation !== null ? (
          <Notice tone="info" title="Your donation is being processed" testId="donation-processing">
            {donation.lastPaymentError === null
              ? `The provider has the payment and will confirm shortly; this page checks back on its own. Your place is held${donation.reservationExpiresAt === null ? '' : ` until ${formatTime(donation.reservationExpiresAt, timeZone)}`}.`
              : `The last attempt was declined (${donation.lastPaymentError}). Try another card; your place is held${donation.reservationExpiresAt === null ? '' : ` until ${formatTime(donation.reservationExpiresAt, timeZone)}`}.`}
          </Notice>
        ) : null}
        {step1 === 'received' && donation !== null ? (
          <Notice tone="success" title="Donation received" testId="donation-received">
            {formatCents(donation.amountCents, donation.currency)} went to {charityName}. Thank you.
          </Notice>
        ) : null}
        {step1 === 'failed' ? (
          <Notice tone="error" title="The donation did not go through">
            The payment was cancelled or refused. Register again to try another card.
          </Notice>
        ) : null}
        {step1 === 'refunded' ? (
          <Notice tone="info" title="The donation was refunded">
            The team's place was released with the refund. Contact the organizer if that was not expected.
          </Notice>
        ) : null}

        {canRegister && teamId !== null ? (
          <RegisterButton slug={slug} teamId={teamId} label={BigInt(entryDonationCents) > 0n ? `Donate ${amount} and register ${teamName ?? 'the team'}` : `Register ${teamName ?? 'the team'}`} stripePublishableKey={stripePublishableKey} tournamentName={tournamentName} />
        ) : null}
        {step1 === 'processing' && donation !== null && donation.status === 'pending' && state.kind === 'registered' ? <ResumePayment donationId={donation.id} stripePublishableKey={stripePublishableKey} tournamentName={tournamentName} /> : null}
        {state.kind === 'no_team' ? (
          <LinkButton component={Link} variant="primary" large block href={`/teams/new?t=${slug}`}>
            Create a team
          </LinkButton>
        ) : null}
      </StepCard>

      <StepCard
        number={2}
        title="Enter the contest on Purse"
        tone="purse"
        status={
          entry === null ? (
            <span className="inline-flex items-center gap-1.5 type-label text-text-tertiary">
              <Icons.lock size={14} />
              Opens after step 1
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 type-label text-text-secondary">
              <Icons.shieldCheck size={14} />
              Runs on Purse
            </span>
          )
        }
      >
        {entry ?? (
          <p className="text-text-secondary">
            Entering the contest is a separate step run by Purse, the platform that holds the contest, its rewards and its settlement. Each player confirms a free entry of 100 POINTS in Purse’s own frame. It unlocks once
            the team holds its place; your donation above is never staked.
          </p>
        )}
      </StepCard>

      <p className="text-text-secondary">
        <Link href="/me" className="link-inline text-text-primary hover:text-volt">
          Your profile
        </Link>{' '}
        shows every event you are in and the state of each entry.
      </p>
    </div>
  );
}
