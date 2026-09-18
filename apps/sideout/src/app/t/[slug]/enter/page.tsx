import { and, asc, desc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

import { Card, Chip, Label, Notice } from '../../../../components/ui';
import { donations, purseEntries, teamMembers, teams, tournaments, users } from '../../../../db/schema';
import { env } from '../../../../env';
import { pageUser } from '../../../../server/auth/current-user';
import { appContext } from '../../../../server/context';
import { confirmedTeam } from '../../../../server/field';
import { activeTeamFor } from '../../../../server/teams';
import { EntryStep } from './EntryStep';

export const dynamic = 'force-dynamic';

/**
 * Registration's second step for the signed-in player: the donation (step 1, made
 * already) on one surface, and the Purse contest entry (step 2) on a visibly different
 * one, so the two are never confused (spec 5.3, "Register").
 */
export default async function EnterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const app = appContext();
  const { db } = app;
  const [tournament] = await db.select().from(tournaments).where(eq(tournaments.slug, slug));
  if (tournament === undefined || tournament.status === 'draft') notFound();
  const user = await pageUser({ db, sessionSecret: env().sessionSecret, now: new Date() });
  if (user === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="display text-display-l text-text-primary">{tournament.name}</h1>
        <Notice tone="warning" title="Sign in first">Sign in to complete your registration.</Notice>
      </div>
    );
  }
  const team = await activeTeamFor(db, tournament.id, user.id);
  if (team === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="display text-display-l text-text-primary">{tournament.name}</h1>
        <Notice title="No team yet">Create or join a team in this tournament first.</Notice>
      </div>
    );
  }
  const members = await db
    .select({ userId: users.id, displayName: users.displayName, role: teamMembers.role, purseUserId: users.purseUserId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, team.id))
    .orderBy(asc(teamMembers.role), asc(teamMembers.createdAt));
  const held = await db.select().from(purseEntries).where(and(eq(purseEntries.tournamentId, tournament.id), eq(purseEntries.state, 'entered')));
  const entered = new Set(held.map((h) => h.userId));
  const [donation] = await db.select().from(donations).where(eq(donations.teamId, team.id)).orderBy(desc(donations.createdAt)).limit(1);
  // The same rule capacity uses (`server/field.ts`): the donation succeeded, or the entry was free.
  const [confirmed] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, team.id), confirmedTeam()));
  const donationDone = confirmed !== undefined;
  const players = members.map((m) => ({ userId: m.userId, displayName: m.displayName, role: m.role, linked: m.purseUserId !== null, entered: entered.has(m.userId) }));
  const entriesOpen = tournament.status === 'registration_open' || tournament.status === 'registration_closed';

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Label>Register · {team.name}</Label>
        <h1 className="display text-display-l text-text-primary">{tournament.name}</h1>
      </header>

      <Card className="border-ember/40">
        <div className="flex items-center justify-between gap-2">
          <Label>Step 1 · Charitable donation</Label>
          <Chip tone={donationDone ? 'positive' : donation?.status === 'pending' ? 'warning' : 'neutral'}>{donation?.status ?? (donationDone ? 'free entry' : 'not started')}</Chip>
        </div>
        <p className="mt-2 text-body text-text-secondary">
          {tournament.entryDonationCents === 0n
            ? 'This event has no entry donation.'
            : donationDone
              ? `Your team’s donation to the beneficiary is in. It is a gift, not a stake, and it never touches the contest.`
              : 'Your team’s entry donation has not settled yet. It goes to the beneficiary through Stripe and never touches the contest.'}
        </p>
      </Card>

      <Card className="border-volt/40 bg-bg-overlay">
        <div className="flex items-center justify-between gap-2">
          <Label>Step 2 · Contest entry on Purse</Label>
          <Chip tone={players.every((p) => p.entered) ? 'positive' : 'neutral'}>{players.filter((p) => p.entered).length} of {players.length} entered</Chip>
        </div>
        <p className="mt-2 text-body text-text-secondary">
          Separate from the donation: each player confirms their own free entry (100 POINTS, granted when your Purse account is linked) in Purse’s own frame. Sideout then reads the contest back to record it.
        </p>
        <div className="mt-4">
          {app.purse === null || env().purse.publishableKey === undefined ? (
            <Notice tone="warning" title="Purse is not configured">The server needs SIDEOUT_PURSE_SECRET_KEY and NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY to open the entry flow.</Notice>
          ) : !donationDone ? (
            <Notice title="After the donation">The contest entry opens once the donation has settled.</Notice>
          ) : !entriesOpen ? (
            <Notice title="Entries are closed">The tournament is {tournament.status.replace(/_/g, ' ')}.</Notice>
          ) : (
            <EntryStep teamId={team.id} tournamentSlug={tournament.slug} initialPlayers={players} viewerUserId={user.id} />
          )}
        </div>
      </Card>
    </div>
  );
}
