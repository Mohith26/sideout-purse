'use client';

import { ActionButton, Icons } from '@sideout/ui';

import { cx } from '../../lib/cx';
import { formatPoints } from '../../lib/format';
import { usePurse } from './PurseGate';
import { PurseNotice } from './PurseNotice';
import { ResponsiblePlayLinks } from './ResponsiblePlayLinks';

/**
 * The wallet chip (spec 5.3, "Profile"): the balances Purse holds for the player, read
 * live through the gate and never stored (decision D3: closed-loop POINTS and CREDIT,
 * no cash), the Purse wallet flow behind one button, and the responsible-play links
 * directly beneath any balance.
 */
export function WalletChip({ policyHref, selfLimitHref, supportHref, className }: { policyHref: string; selfLimitHref: string; supportHref: string; className?: string }) {
  const purse = usePurse();
  const { profile, busy, failure, config } = purse;
  const linked = profile.kind === 'ready' && profile.profile.linked;
  const balances = profile.kind === 'ready' ? profile.profile.wallet : [];
  const state = config === null ? 'unconfigured' : profile.kind === 'ready' ? (linked ? 'linked' : 'unlinked') : profile.kind;
  return (
    <div className={cx('surface-raised rounded-card p-4', className)} data-testid="wallet-chip" data-state={state} aria-busy={config !== null && (profile.kind === 'loading' || profile.kind === 'unknown')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="type-label text-text-tertiary">Purse wallet</p>
          {linked ? (
            balances.length === 0 ? (
              <p className="mt-1 text-text-secondary">No balances yet.</p>
            ) : (
              <p className="tabular mt-1 flex flex-wrap gap-x-4 text-heading font-semibold text-text-primary" data-testid="wallet-balance">
                {balances.map((b) => (
                  <span key={b.asset}>{formatPoints(b.balance, b.asset)}</span>
                ))}
              </p>
            )
          ) : config === null ? (
            <p className="mt-1 text-text-secondary">Purse is not configured on this server.</p>
          ) : profile.kind === 'loading' || profile.kind === 'unknown' ? (
            <p className="mt-1 text-text-secondary">Reading your wallet from Purse…</p>
          ) : profile.kind === 'unavailable' ? (
            <p className="mt-1 text-text-secondary">Purse could not be reached.</p>
          ) : (
            <p className="mt-1 text-text-secondary">Contest entries and rewards settle in Purse. Link your account to see the balance.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {linked ? (
            <ActionButton variant="secondary" disabled={busy} onClick={() => void purse.open('wallet')} iconStart={<Icons.wallet size={16} />}>
              Wallet
            </ActionButton>
          ) : config !== null && profile.kind === 'ready' ? (
            <ActionButton variant="secondary" disabled={busy} onClick={() => void purse.link()}>
              Link Purse account
            </ActionButton>
          ) : profile.kind === 'unavailable' ? (
            <ActionButton variant="secondary" disabled={busy} onClick={() => void purse.refreshProfile()}>
              Try again
            </ActionButton>
          ) : null}
        </div>
      </div>
      {linked ? <p className="mt-2 type-label text-text-tertiary">POINTS are free-to-play; nothing here is cash and nothing here was your donation.</p> : null}
      {linked ? <ResponsiblePlayLinks policyHref={policyHref} selfLimitHref={selfLimitHref} className="mt-3" /> : null}
      {failure === null ? null : <PurseNotice state={failure} supportHref={supportHref} onRetry={() => void purse.refreshProfile()} className="mt-3" />}
      {profile.kind === 'unavailable' && failure === null ? <PurseNotice state={profile.failure} supportHref={supportHref} onRetry={() => void purse.refreshProfile()} className="mt-3" /> : null}
    </div>
  );
}
