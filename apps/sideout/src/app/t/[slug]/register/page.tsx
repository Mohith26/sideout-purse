import { and, asc, desc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DeviceCheckIn } from '../../../../components/attestation/DeviceCheckIn';
import { LiveRefresh } from '../../../../components/motion/LiveRefresh';
import { PurseGate } from '../../../../components/purse/PurseGate';
import { PurseEntryStep } from '../../../../components/registration/PurseEntryStep';
import { RegistrationSteps } from '../../../../components/registration/RegistrationSteps';
import { registrationState } from '../../../../components/registration/state';
import { donations, purseEntries, teamMembers, users } from '../../../../db/schema';
import { signInHref } from '../../../../lib/redirects';
import { deviceView, listTeamDevices } from '../../../../server/devices';
import { countedTeams, reservationExpiresAt, teamHoldsPlace } from '../../../../server/field';
import { purseBrowserConfig, purseLinks } from '../../../../server/pages';
import { activeTeamFor } from '../../../../server/teams';
import { tournamentPage } from '../_lib';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Register' };

/** While the provider still shows a donation as pending, check back at this cadence. */
const PENDING_REFRESH_MS = 5_000;

/**
 * Registration (spec 5.3, "Register"): the two visually distinct steps for the viewer's
 * team in this event, and the phone check-in (spec section 12, item 1). Anonymous
 * visitors sign in first and come back here. Once the team holds its place, step 2 is
 * live: each player's own Purse entry, read back from the contest and recorded server
 * side; and step 3 lets each player check in the phone they will score from, until play
 * ends. Phase 7's `/t/[slug]/enter` folds in here.
 */
export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { app, user, row, summary, clock } = await tournamentPage(slug);
  if (user === null) redirect(signInHref(`/t/${slug}/register`));
  const t = summary.tournament;
  const { db } = app;

  const team = await activeTeamFor(db, row.tournament.id, user.id);
  const members =
    team === null
      ? []
      : await db
          .select({ userId: users.id, displayName: users.displayName, role: teamMembers.role, purseUserId: users.purseUserId })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(eq(teamMembers.teamId, team.id))
          .orderBy(asc(teamMembers.role), asc(teamMembers.createdAt));
  const [donation] = team === null ? [] : await db.select().from(donations).where(eq(donations.teamId, team.id)).orderBy(desc(donations.createdAt)).limit(1);
  const holdsPlace = team === null ? false : await teamHoldsPlace(db, team.id, clock);
  const counted = await countedTeams(db, row.tournament.id, clock, team === null ? {} : { excluding: team.id });
  const isCaptain = members.some((m) => m.userId === user.id && m.role === 'captain');
  const state = registrationState({
    tournamentStatus: t.status,
    team: team === null ? null : { status: team.status, memberCount: members.length, invitedPhone: team.invitedPhoneE164, holdsPlace, isCaptain },
    donation:
      donation === undefined
        ? null
        : {
            id: donation.id,
            status: donation.status,
            amountCents: donation.amountCents.toString(),
            currency: donation.currency,
            lastPaymentError: donation.status === 'pending' ? donation.lastPaymentError : null,
            reservationExpiresAt: donation.status === 'pending' ? reservationExpiresAt(donation, clock).toISOString() : null,
          },
    entryDonationCents: t.entryDonationCents,
    full: counted >= t.maxTeams,
  });

  const held = team === null ? [] : await db.select().from(purseEntries).where(and(eq(purseEntries.tournamentId, row.tournament.id), eq(purseEntries.state, 'entered')));
  const entered = new Set(held.map((h) => h.userId));
  const players = members.map((m) => ({ userId: m.userId, displayName: m.displayName, role: m.role, linked: m.purseUserId !== null, entered: entered.has(m.userId) }));
  const links = purseLinks(app);
  const entry =
    state.kind === 'registered' && team !== null ? (
      <PurseEntryStep teamId={team.id} tournamentSlug={t.slug} initialPlayers={players} viewerUserId={user.id} supportHref={links.supportHref} entriesOpen={state.entriesOpen} />
    ) : null;
  const devices = state.kind === 'registered' && team !== null ? (await listTeamDevices(db, [team.id])).map(deviceView) : [];
  const checkIn =
    state.kind === 'registered' && team !== null ? (
      <DeviceCheckIn
        teamId={team.id}
        teamName={team.name}
        viewerUserId={user.id}
        members={members.map((m) => ({ userId: m.userId, displayName: m.displayName }))}
        devices={devices}
        open={t.status === 'registration_open' || t.status === 'registration_closed' || t.status === 'live'}
        timeZone={t.venue.timezone}
      />
    ) : null;

  const steps = (
    <RegistrationSteps
      slug={t.slug}
      tournamentName={t.name}
      charityName={t.beneficiary.name}
      entryDonationCents={t.entryDonationCents}
      currency={summary.currency}
      timeZone={t.venue.timezone}
      state={state}
      teamId={team?.id ?? null}
      teamName={team?.name ?? null}
      stripePublishableKey={app.env.stripePublishableKey ?? null}
      entry={entry}
      checkIn={checkIn}
    />
  );

  return (
    <div className="mx-auto max-w-2xl">
      {state.kind === 'registered' && state.donation?.status === 'pending' ? <LiveRefresh intervalMs={PENDING_REFRESH_MS} /> : null}
      <h2 className="sr-only">Register for {t.name}</h2>
      {team === null ? null : (
        <p className="mb-4 text-text-secondary">
          Registering <span className="font-medium text-text-primary">{team.name}</span>
          {members.length > 0 ? <span className="text-text-tertiary"> · {members.map((m) => m.displayName).join(' & ')}</span> : null}
        </p>
      )}
      {entry === null ? (
        steps
      ) : (
        <PurseGate config={purseBrowserConfig(app)} signedIn>
          {steps}
        </PurseGate>
      )}
    </div>
  );
}
