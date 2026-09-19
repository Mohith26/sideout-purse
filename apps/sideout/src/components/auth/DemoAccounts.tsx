'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ActionButton, Icons, StatusPill, type IconName } from '@sideout/ui';

import type { DemoAccountKey } from '../../db/seed/demo';
import { api } from '../../lib/api-client';
import type { DemoAccount } from '../../lib/demo-accounts';
import { formatCents } from '../../lib/format';
import { safeNextPath } from '../../lib/redirects';
import { MATCH_STATUS_PILL, TEAM_STATUS_PILL, VERIFICATION_STATE_PILL } from '../status/pills';
import { Notice } from '../ui/Notice';

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`, `docs/demo-accounts.md`): rendered
 * by `/sign-in` only while the switch is on, above the untouched phone form. Each card is
 * one of the curated seeded users with what they can do right now, read from the rows on
 * the server; choosing one calls `POST /api/auth/demo` and lands where that account's
 * story starts. Every such session is marked and the shell shows the "Demo" pill for it.
 */
const TITLE: Record<DemoAccountKey, string> = {
  captain_a: 'Captain A',
  captain_b: 'Captain B',
  registrant: 'Registering captain',
  organizer: 'Organizer',
  refused: 'Player Purse refuses',
  verifying: 'Player still to verify',
};

const ICON: Record<DemoAccountKey, IconName> = {
  captain_a: 'trophy',
  captain_b: 'trophy',
  registrant: 'users',
  organizer: 'console',
  refused: 'ban',
  verifying: 'shieldCheck',
};

function explain(account: DemoAccount): string {
  const d = account.detail;
  const event = account.tournament.name;
  switch (d.kind) {
    case 'match': {
      const opponent = d.opponentName === null ? '' : ` against ${d.opponentName}`;
      const where = `${d.teamName}'s captain in the ${event} ${d.round.toLowerCase()}${opponent}.`;
      if (d.ownScorelineIn) return `${where} Their scoreline is in; they can revise it, or watch the other side answer.`;
      if (d.opponentScorelineIn) return `${where} The other side has submitted: entering the same result makes the match final, a different one opens a dispute for the organizer.`;
      return `${where} Submits their side's scoreline first; nothing is final until both teams agree.`;
    }
    case 'register': {
      const gift = d.entryDonationCents === '0' ? 'free entry' : `a ${formatCents(d.entryDonationCents)} entry donation`;
      if (d.teamStatus === 'forming') return `Captain of ${d.teamName}, a complete pair that has not entered ${event} yet. Walks the two steps: ${gift}, then the Purse contest entry in Purse's own frame.`;
      if (!d.holdsPlace) return `Captain of ${d.teamName}: their ${event} checkout never finished, so the team holds no place until they register again (${gift}), then enter the contest on Purse.`;
      return `Captain of ${d.teamName}, entered in ${event}. Shows the finished registration and the Purse entry step.`;
    }
    case 'organizer':
      return `Runs ${event}: the court board, the dispute queue${d.disputes > 0 ? ` (${d.disputes} waiting)` : ''}, the Purse reconciliation page and the two-step close through the frozen preview.`;
    case 'purse':
      if (account.key === 'refused') {
        return 'Purse could not verify this player and holds a date of birth under the minimum age: the profile shows the terminal decision with a support path and no retry, and every contest entry is refused.';
      }
      return d.linked
        ? 'Linked to Purse but not verified yet. The profile’s identity row opens Purse’s identity flow in its own frame; a name and a date of birth are all the sandbox provider asks for.'
        : 'Not linked to Purse yet. The profile links the account and opens Purse’s identity flow.';
  }
}

function statePill(account: DemoAccount) {
  const d = account.detail;
  switch (d.kind) {
    case 'match':
      return <StatusPill size="sm" spec={MATCH_STATUS_PILL[d.matchStatus]} />;
    case 'register':
      return <StatusPill size="sm" spec={d.teamStatus === 'registered' && !d.holdsPlace ? { label: 'Place lapsed', tone: 'attention', icon: 'clock' } : TEAM_STATUS_PILL[d.teamStatus]} />;
    case 'purse':
      return d.verificationState === null ? <StatusPill size="sm" spec={{ label: 'Not linked', tone: 'muted', icon: 'circleDashed' }} /> : <StatusPill size="sm" spec={VERIFICATION_STATE_PILL[d.verificationState]} />;
    case 'organizer':
      return d.disputes > 0 ? <StatusPill size="sm" spec={{ label: `${d.disputes} dispute${d.disputes === 1 ? '' : 's'}`, tone: 'attention', icon: 'triangleAlert' }} /> : null;
  }
}

type SignedIn = { href: string };

export function DemoAccounts({ accounts, next }: { accounts: DemoAccount[]; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<DemoAccountKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(account: DemoAccount) {
    setError(null);
    setBusy(account.key);
    const result = await api<SignedIn>('/api/auth/demo', { method: 'POST', body: { account: account.key } });
    if (!result.ok) {
      setBusy(null);
      setError(result.error.code === 'too_many_requests' ? 'Too many demo sign-ins from here; wait a moment and try again.' : result.error.message);
      return;
    }
    // A deep link (`?next=`) is honoured; otherwise the account's own story wins over the profile.
    const target = next === '/me' ? safeNextPath(result.data.href, account.href) : next;
    router.replace(target);
    router.refresh();
  }

  return (
    <section aria-labelledby="demo-accounts-heading" data-testid="demo-accounts" className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-fault">
          <Icons.flag size={18} />
        </span>
        <div className="min-w-0">
          <h2 id="demo-accounts-heading" className="type-heading">
            Demo accounts
          </h2>
          <p className="mt-1 text-text-secondary">
            This is a public demo on seeded events. Pick a role to sign in as that seeded player or organizer; no code is sent. Every demo sign-in is recorded, and the data returns to this starting point nightly.
          </p>
        </div>
      </div>
      {error === null ? null : (
        <Notice tone="error" title="Could not sign in">
          {error}
        </Notice>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {accounts.map((account) => {
          const Icon = Icons[ICON[account.key]];
          return (
            <li key={account.key} data-testid={`demo-account-${account.key}`} className="surface-raised flex min-w-0 flex-col gap-3 rounded-card p-4 md:p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-text-tertiary">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">{TITLE[account.key]}</p>
                    <p className="type-label text-text-secondary">{account.displayName}</p>
                  </div>
                </div>
                {statePill(account)}
              </div>
              <p className="min-w-0 flex-1 text-text-secondary">{explain(account)}</p>
              <ActionButton type="button" variant="secondary" block disabled={busy !== null} aria-busy={busy === account.key} onClick={() => void choose(account)} iconEnd={<Icons.arrowRight size={16} />}>
                {busy === account.key ? 'Signing in…' : `Sign in as ${account.displayName}`}
              </ActionButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
