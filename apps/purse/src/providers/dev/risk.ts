import type { RiskAssessment, RiskProvider, RiskSignal, RiskTransaction } from '../types';

/**
 * The dev risk provider: applies the spec 4.6 velocity and duplicate-account rules as
 * signals (spec 4.5). This is where Sardine would plug in; a real provider scores device,
 * behaviour and payment signals and can deny outright.
 *
 * The evaluator enforces the limits themselves; this seam surfaces what a human should
 * look at. An entry that brings the user within `NEAR_LIMIT_SHARE` of a rolling limit,
 * a user carrying an open duplicate-identity flag, or an account minutes old staking at the
 * per-contest limit all produce a signal and a `review` decision, which the entry path
 * records as an operator flag and otherwise lets through: spec 4.6 flags, it does not
 * auto-block. The dev provider never returns `deny`.
 */
export const DEV_RISK_PROVIDER_NAME = 'dev';

export const NEAR_LIMIT_SHARE = 0.8;
export const NEW_ACCOUNT_MS = 60 * 60_000;

export function devRiskProvider(): RiskProvider {
  return {
    name: DEV_RISK_PROVIDER_NAME,
    assess(transaction: RiskTransaction): Promise<RiskAssessment> {
      return Promise.resolve(assessDev(transaction));
    },
  };
}

export function assessDev(transaction: RiskTransaction): RiskAssessment {
  const signals: RiskSignal[] = [];
  const { per24h, per7d, perContest } = transaction.ruleset.stakeLimits;

  const near = (total: bigint, limit: number | null): boolean => limit !== null && limit > 0 && total * 100n >= BigInt(Math.floor(NEAR_LIMIT_SHARE * 100)) * BigInt(limit);
  if (near(transaction.velocity.enteredLast24h + transaction.amount, per24h)) {
    signals.push({ code: 'velocity_near_24h_limit', detail: { staked: (transaction.velocity.enteredLast24h + transaction.amount).toString(), limit: per24h } });
  }
  if (near(transaction.velocity.enteredLast7d + transaction.amount, per7d)) {
    signals.push({ code: 'velocity_near_7d_limit', detail: { staked: (transaction.velocity.enteredLast7d + transaction.amount).toString(), limit: per7d } });
  }
  if (transaction.openFlags.includes('duplicate_identity')) {
    signals.push({ code: 'duplicate_identity_open', detail: { userId: transaction.userId } });
  }
  if (transaction.accountAgeMs < NEW_ACCOUNT_MS && perContest !== null && transaction.amount >= BigInt(perContest)) {
    signals.push({ code: 'new_account_max_stake', detail: { accountAgeMs: transaction.accountAgeMs, amount: transaction.amount.toString() } });
  }
  return { decision: signals.length === 0 ? 'allow' : 'review', signals };
}
