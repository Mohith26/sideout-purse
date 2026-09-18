import { eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState, Icons, LinkButton, SectionHeading } from '@sideout/ui';

import { DisplayNameForm } from '../../components/profile/DisplayNameForm';
import { InviteCard } from '../../components/profile/InviteCard';
import { SignOutButton } from '../../components/profile/SignOutButton';
import { TeamHistoryCard, type TeamHistoryView } from '../../components/profile/TeamHistoryCard';
import { PurseGate } from '../../components/purse/PurseGate';
import { ResponsiblePlayLinks } from '../../components/purse/ResponsiblePlayLinks';
import { RewardsPanel } from '../../components/purse/RewardsPanel';
import { VerificationRow } from '../../components/purse/VerificationRow';
import { WalletChip } from '../../components/purse/WalletChip';
import { DONATION_STATUSES, teams, tournaments, type DonationStatus, type TournamentStatus } from '../../db/schema';
import { maskPhone } from '../../lib/phone';
import { signInHref } from '../../lib/redirects';
import { bracketRoundLabel } from '../../lib/rounds';
import { meSnapshot } from '../../server/me';
import { pageContext, purseBrowserConfig, purseLinks } from '../../server/pages';
import { rewardsFor } from '../../server/rewards';
import { listMatchViews, listTournamentSummaries, teamHistory } from '../../server/screens';
import { tournamentStandings } from '../../server/standings';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Me' };

const CURRENT: readonly TournamentStatus[] = ['registration_open', 'registration_closed', 'live'];
const PLAYED: readonly TournamentStatus[] = ['live', 'awaiting_settlement', 'settled'];

/**
 * Profile (spec 5.3, item 5): who you are, the Purse identity row and wallet chip as calm
 * status rows, invites waiting on you, your teams and how each event went, rewards as
 * Purse settled them, and the responsible-play links. `PurseGate` owns every Purse flow
 * the page launches and reads the live profile; nothing about the wallet is stored here.
 */
export default async function MePage() {
  const { app, user, clock } = await pageContext();
  if (user === null) redirect(signInHref('/me'));
  const { db } = app;
  const [snapshot, rewards, openEvents] = await Promise.all([meSnapshot(db, user, clock), rewardsFor(db, user), listTournamentSummaries(db, clock).then((all) => all.filter((s) => s.tournament.status === 'registration_open'))]);

  const views: TeamHistoryView[] = await Promise.all(
    snapshot.teams.map(async ({ team, tournament }) => {
      const status = tournament.status as TournamentStatus;
      const [row] = await db.select({ timezone: tournaments.venueTimezone, drawConfig: tournaments.drawConfig }).from(tournaments).where(eq(tournaments.id, tournament.id));
      const [teamRow] = await db.select({ invitedPhone: teams.invitedPhoneE164 }).from(teams).where(eq(teams.id, team.id));
      const timezone = row?.timezone ?? 'UTC';
      let history = null;
      if (PLAYED.includes(status)) {
        const matches = await listMatchViews(db, tournament.id);
        const pools = await tournamentStandings(db, { id: tournament.id, drawConfig: row?.drawConfig ?? null });
        const pool = pools.find((p) => p.standings.some((s) => s.teamId === team.id));
        const rank = pool?.standings.find((s) => s.teamId === team.id)?.rank ?? null;
        history = teamHistory(team.id, matches, pool === undefined || rank === null ? null : { label: pool.label, rank }, bracketRoundLabel);
      }
      const donation = snapshot.donations.find((d) => d.tournamentSlug === tournament.slug) ?? null;
      const donationStatus = donation === null ? null : (DONATION_STATUSES as readonly string[]).includes(donation.status) ? (donation.status as DonationStatus) : null;
      return {
        team: { id: team.id, name: team.name, status: team.status, invitedPhone: teamRow?.invitedPhone ?? null, holdsPlace: team.holdsPlace },
        members: team.members,
        tournament: { slug: tournament.slug, name: tournament.name, status, startsAt: tournament.startsAt, timezone },
        donation: donation === null || donationStatus === null ? null : { amountCents: donation.amountCents, currency: donation.currency, status: donationStatus },
        history,
      };
    }),
  );
  const current = views.filter((v) => CURRENT.includes(v.tournament.status) && v.team.status !== 'withdrawn');
  const past = views.filter((v) => !CURRENT.includes(v.tournament.status));
  const joinable = openEvents.filter((s) => !views.some((v) => v.tournament.slug === s.tournament.slug && v.team.status !== 'withdrawn'));
  const hasInvites = snapshot.invites.length > 0;
  const readyTeam = current.find((v) => v.team.status === 'forming' && v.members.length === 2 && v.tournament.status === 'registration_open');
  const links = purseLinks(app);

  return (
    <PurseGate config={purseBrowserConfig(app)} signedIn eager>
      <div className="space-y-10">
        <section aria-labelledby="identity-heading" className="surface-raised flex flex-wrap items-start justify-between gap-4 rounded-card p-5 md:p-6">
          <div className="min-w-0">
            <h1 id="identity-heading" className="type-display-l">
              {snapshot.user.displayName}
            </h1>
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-text-secondary">
              <div className="flex items-center gap-2">
                <Icons.phone size={16} className="text-text-tertiary" />
                <dt className="sr-only">Phone</dt>
                <dd className="tabular">{snapshot.user.phoneE164 === null ? 'No phone on file' : maskPhone(snapshot.user.phoneE164)}</dd>
              </div>
              {snapshot.user.role === 'organizer' ? (
                <div className="flex items-center gap-2">
                  <Icons.console size={16} className="text-text-tertiary" />
                  <dt className="sr-only">Role</dt>
                  <dd>
                    Organizer ·{' '}
                    <Link href="/organizer" className="link-inline text-text-primary hover:text-volt">
                      open the console
                    </Link>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
          <SignOutButton />
        </section>

        {snapshot.user.displayNameIsDefault ? <DisplayNameForm current="" /> : null}

        <section aria-labelledby="purse-heading">
          <SectionHeading id="purse-heading">Purse</SectionHeading>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <VerificationRow supportHref={links.supportHref} />
            <WalletChip policyHref={links.policyHref} selfLimitHref={links.selfLimitHref} supportHref={links.supportHref} />
          </div>
        </section>

        {hasInvites ? (
          <section aria-labelledby="invites-heading">
            <SectionHeading id="invites-heading" aside={<span className="tabular">{snapshot.invites.length}</span>}>
              Invites waiting on you
            </SectionHeading>
            <div className="space-y-3">
              {snapshot.invites.map((invite, i) => (
                <InviteCard key={invite.teamId} invite={invite} primary={i === 0} />
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="teams-heading">
          <SectionHeading id="teams-heading">Your teams</SectionHeading>
          {current.length === 0 ? (
            <EmptyState
              icon="users"
              title="No team in an upcoming event"
              body={joinable.length > 0 ? `Registration is open for ${joinable.map((s) => s.tournament.name).join(', ')}. Create a team and invite your partner by phone.` : 'When an event opens registration, create a team here.'}
              action={
                joinable[0] === undefined ? undefined : (
                  <LinkButton component={Link} variant={hasInvites ? 'secondary' : 'primary'} href={`/teams/new?t=${joinable[0].tournament.slug}`}>
                    Create a team
                  </LinkButton>
                )
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {current.map((v) => (
                <TeamHistoryCard key={v.team.id} view={v} primaryAction={!hasInvites && readyTeam?.team.id === v.team.id} />
              ))}
            </div>
          )}
          {current.length > 0 && joinable.length > 0 ? (
            <p className="mt-3 text-text-secondary">
              Also open:{' '}
              {joinable.map((s, i) => (
                <span key={s.tournament.id}>
                  {i > 0 ? ', ' : ''}
                  <Link href={`/teams/new?t=${s.tournament.slug}`} className="link-inline text-text-primary hover:text-volt">
                    {s.tournament.name}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="history-heading">
          <SectionHeading id="history-heading" aside={<span className="tabular">{past.length} events</span>}>
            Tournament history
          </SectionHeading>
          {past.length === 0 ? (
            <EmptyState icon="trophy" title="Nothing played yet" body="Results, pool finishes and bracket runs from past events collect here." />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {past.map((v) => (
                <TeamHistoryCard key={v.team.id} view={v} primaryAction={false} />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="rewards-heading">
          <SectionHeading id="rewards-heading" aside={<span className="tabular">{rewards.length}</span>}>
            Rewards
          </SectionHeading>
          <RewardsPanel rewards={rewards} />
        </section>

        <section aria-labelledby="responsible-heading" className="surface-inset rounded-card p-5">
          <SectionHeading id="responsible-heading">Responsible play</SectionHeading>
          <p className="max-w-prose text-text-secondary">
            Contest entries and rewards on Sideout are settled by Purse in POINTS, a closed-loop asset with no cash value. Entry fees are charitable donations and are never staked. If play stops feeling like play, Purse publishes
            limits, cooling-off and self-exclusion tools alongside its policy.
          </p>
          <ResponsiblePlayLinks policyHref={links.policyHref} selfLimitHref={links.selfLimitHref} className="mt-3" />
        </section>
      </div>
    </PurseGate>
  );
}
