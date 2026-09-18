import Link from 'next/link';
import { Icons, LinkButton, StatusPill } from '@sideout/ui';

import type { DonationStatus, TeamStatus, TournamentStatus } from '../../db/schema';
import type { TeamHistory } from '../../server/screens';
import { cx } from '../../lib/cx';
import { formatCents, formatDate, ordinal } from '../../lib/format';
import { maskPhone } from '../../lib/phone';
import { DONATION_STATUS_PILL, TEAM_STATUS_PILL, TOURNAMENT_STATUS_PILL } from '../status/pills';
import { TeamAvatarPair } from '../tournament/TeamAvatarPair';

/**
 * One team in one event, as the profile shows it: where it stands now (forming,
 * registered, withdrawn), its entry donation, and once play starts the record, pool
 * finish, bracket run and every match, all read off rows.
 */
export type TeamHistoryView = {
  team: { id: string; name: string; status: TeamStatus; invitedPhone: string | null; holdsPlace: boolean };
  members: ReadonlyArray<{ displayName: string }>;
  tournament: { slug: string; name: string; status: TournamentStatus; startsAt: string; timezone: string };
  donation: { amountCents: string; currency: string; status: DonationStatus } | null;
  history: TeamHistory | null;
};

export function TeamHistoryCard({ view, primaryAction }: { view: TeamHistoryView; primaryAction: boolean }) {
  const { team, tournament, members, donation, history } = view;
  const open = tournament.status === 'registration_open';
  const complete = members.length === 2;
  const registerHref = `/t/${tournament.slug}/register`;
  const played = history !== null && (history.played > 0 || history.bracketRoundReached !== null);

  return (
    <article className="surface-raised flex min-w-0 flex-col gap-4 rounded-card p-4 md:p-5" aria-label={`${team.name} at ${tournament.name}`} data-testid="team-history-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/t/${tournament.slug}`} className="target inline-flex min-w-0 items-center font-medium text-text-primary hover:text-volt">
          <span className="truncate">{tournament.name}</span>
        </Link>
        <span className="flex items-center gap-2">
          <span className="tabular type-label text-text-tertiary">{formatDate(tournament.startsAt, tournament.timezone)}</span>
          <StatusPill spec={TOURNAMENT_STATUS_PILL[tournament.status]} size="sm" />
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TeamAvatarPair members={members} teamName={team.name} />
        <StatusPill spec={TEAM_STATUS_PILL[team.status]} size="sm" />
      </div>

      {team.status === 'forming' ? (
        complete ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-text-secondary">Both players are in. {open ? 'Register the team to enter the event.' : 'Registration is closed, so the team cannot enter.'}</p>
            {open ? (
              <LinkButton component={Link} variant={primaryAction ? 'primary' : 'secondary'} href={registerHref}>
                Register
              </LinkButton>
            ) : null}
          </div>
        ) : (
          <p className="flex items-start gap-2 text-text-secondary">
            <Icons.hourglass size={16} className="mt-1 shrink-0 text-text-tertiary" />
            <span>
              {team.invitedPhone === null ? (
                'Waiting for a partner.'
              ) : (
                <>
                  Invite sent to <span className="tabular text-text-primary">{maskPhone(team.invitedPhone)}</span>. They accept it by signing in with that number.
                </>
              )}
            </span>
          </p>
        )
      ) : null}

      {(team.status === 'registered' || team.status === 'checked_in') && !team.holdsPlace && open ? (
        <p className="flex items-start gap-2 text-text-secondary">
          <Icons.hourglass size={16} className="mt-1 shrink-0 text-text-tertiary" />
          <span>The reservation lapsed without a payment. Register again to hold the place.</span>
        </p>
      ) : null}

      {donation === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
          <span className="text-text-secondary">
            Entry donation <span className="tabular font-medium text-ember">{formatCents(donation.amountCents, donation.currency)}</span>
          </span>
          <span className="flex items-center gap-2">
            <StatusPill spec={DONATION_STATUS_PILL[donation.status]} size="sm" />
            {open ? (
              <Link href={registerHref} className="target inline-flex items-center rounded-input px-2 type-label text-text-secondary hover:text-text-primary">
                Details
              </Link>
            ) : null}
          </span>
        </div>
      )}

      {played && history !== null ? (
        <>
          <dl className="grid grid-cols-3 gap-2 border-t border-border-subtle pt-3">
            <div>
              <dt className="type-label text-text-tertiary">Record</dt>
              <dd className="tabular font-medium text-text-primary">{`${history.wins}–${history.losses}`}</dd>
            </div>
            <div>
              <dt className="type-label text-text-tertiary">Pool</dt>
              <dd className="tabular font-medium text-text-primary">{history.poolLabel === null ? '—' : `${history.poolRank === null ? '' : `${ordinal(history.poolRank)} in `}${history.poolLabel}`}</dd>
            </div>
            <div>
              <dt className="type-label text-text-tertiary">Bracket</dt>
              <dd className={cx('font-medium', history.champion ? 'text-surf' : 'text-text-primary')}>{history.champion ? 'Champions' : (history.bracketRoundReached ?? '—')}</dd>
            </div>
          </dl>
          <details className="group border-t border-border-subtle pt-3">
            <summary className="target -my-2 flex cursor-pointer list-none items-center justify-between type-label text-text-secondary hover:text-text-primary">
              <span>{`Matches · ${history.matches.length}`}</span>
              <Icons.chevronDown size={16} className="transition-transform duration-(--d-micro) group-open:rotate-180" />
            </summary>
            <ol className="mt-2 divide-y divide-border-subtle">
              {history.matches.map((m) => (
                <li key={m.matchId}>
                  <Link href={`/m/${m.matchId}`} className="flex min-h-11 items-center justify-between gap-3 py-1.5 hover:text-text-primary">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-text-primary">{m.status === 'bye' ? 'Bye' : `vs ${m.opponentName ?? 'TBD'}`}</span>
                      <span className="block type-label text-text-tertiary">{m.roundLabel}</span>
                    </span>
                    <span className="tabular shrink-0 text-end type-stat text-text-secondary">
                      {m.status === 'final' && m.sets.length > 0 ? m.sets.map((s) => `${s.mine}–${s.theirs}`).join(' ') : m.status === 'forfeited' ? 'Forfeit' : m.status === 'bye' ? '' : m.status.replace('_', ' ')}
                    </span>
                    <span className={cx('w-5 shrink-0 text-end type-label', m.won === true ? 'text-surf' : 'text-text-tertiary')}>{m.won === null ? '' : m.won ? 'W' : 'L'}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : null}
    </article>
  );
}
