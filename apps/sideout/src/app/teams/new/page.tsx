import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState, LinkButton } from '@sideout/ui';

import { CreateTeamForm } from '../../../components/registration/CreateTeamForm';
import { signInHref } from '../../../lib/redirects';
import { pageContext } from '../../../server/pages';
import { listTournamentSummaries } from '../../../server/screens';
import { activeTeamFor } from '../../../server/teams';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Create a team' };

/** Create a team for an event with open registration and invite a partner by phone (spec 5.3, "Register"). */
export default async function NewTeamPage({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  const { t } = await searchParams;
  const slug = Array.isArray(t) ? t[0] : t;
  const { app, user, clock } = await pageContext();
  if (user === null) redirect(signInHref(slug === undefined ? '/teams/new' : `/teams/new?t=${encodeURIComponent(slug)}`));
  const open = (await listTournamentSummaries(app.db, clock)).filter((s) => s.tournament.status === 'registration_open');
  const chosen = slug === undefined ? undefined : open.find((s) => s.tournament.slug === slug);

  if (chosen === undefined) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <h1 className="type-display-l">Create a team</h1>
        {open.length === 0 ? (
          <EmptyState level={2} icon="calendar" title="No event is open for registration" body="When an organizer opens registration, teams can form here." />
        ) : (
          <div className="space-y-3">
            <p className="text-text-secondary">Which event?</p>
            <ul className="space-y-2">
              {open.map((s) => (
                <li key={s.tournament.id}>
                  <LinkButton component={Link} variant="secondary" block href={`/teams/new?t=${s.tournament.slug}`}>
                    {s.tournament.name}
                  </LinkButton>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const existing = await activeTeamFor(app.db, chosen.tournament.id, user.id);
  if (existing !== null && existing.status !== 'forming') redirect(`/t/${chosen.tournament.slug}/register`);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <p className="type-label text-text-tertiary">{chosen.tournament.name}</p>
        <h1 className="type-display-l mt-1">Create a team</h1>
        <p className="mt-2 text-text-secondary">
          Beach volleyball is played in twos. Name the pair and give your partner’s phone number; they accept by signing in with it. Then the captain makes the entry donation and each of you enters the contest on Purse.
          {existing === null ? '' : ' You already have a team forming; creating another replaces it.'}
        </p>
      </div>
      <CreateTeamForm slug={chosen.tournament.slug} tournamentName={chosen.tournament.name} />
    </div>
  );
}
