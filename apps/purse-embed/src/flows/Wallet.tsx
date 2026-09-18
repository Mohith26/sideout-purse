'use client';

import type { EmbedUserState } from '@purse/types';

import { Button, formatMoney, Notice } from '../components/ui';

/**
 * Balances by asset (spec 4.8), with the responsible-play links every wallet-bearing
 * screen carries. Closed-loop assets only (decision D3): points and credit, never cash.
 */
export function Wallet({ state, onDone }: { state: EmbedUserState; onDone: () => void }) {
  if (!state.authenticated) return <Notice tone="error" title="No session">Open this flow with an embed token or sign in first.</Notice>;
  const active = state.user.restrictions.filter((restriction) => restriction.kind === 'self_exclusion' || restriction.kind === 'cool_off');
  return (
    <>
      <div className="card">
        {state.user.wallet.map((balance) => (
          <div key={balance.asset} className="stat">
            <span className="label">{balance.asset === 'POINTS' ? 'Points' : 'Credit'}</span>
            <span className="stat__value">{formatMoney(balance.balance)}</span>
          </div>
        ))}
        <p className="muted">Points are free to play. Credit is funded by sponsors and redeemable for goods. Neither is cash and neither can be withdrawn.</p>
      </div>
      {active.length > 0 ? (
        <Notice tone="info" title={active[0]?.kind === 'self_exclusion' ? 'You are taking a break' : 'Cooling off'}>
          {active[0]?.endsAt === null || active[0]?.endsAt === undefined ? 'Contest entry is paused until you lift it with support.' : `Contest entry is paused until ${new Date(active[0].endsAt).toLocaleDateString()}.`}
        </Notice>
      ) : null}
      <div className="card">
        <span className="label">Play responsibly</span>
        <p className="embed__lede">
          Set limits, take a break or exclude yourself at any time.{' '}
          <a className="link" href="https://www.ncpgambling.org/help-treatment/" target="_blank" rel="noreferrer noopener">
            Help is available
          </a>
          .
        </p>
      </div>
      <div className="actions">
        <Button onClick={onDone}>Done</Button>
      </div>
    </>
  );
}
