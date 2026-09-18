import { and, eq, isNull } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { accounts, NORMAL_SIDE_BY_KIND, type Account, type AccountKind, type Asset } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from './audit';
import { LedgerError } from './errors';

export type OpenAccountInput = {
  tenantId: Id<'tnt'>;
  kind: AccountKind;
  /** The user id for a wallet, the contest id for an escrow, `null` for a platform account. */
  ownerRef: string | null;
  asset: Asset;
  actor?: Actor;
  requestId?: string;
};

export type OpenedAccount = { account: Account; created: boolean };

/**
 * Open an account, or return the one that already exists for the same
 * (tenant, kind, owner, asset). The unique constraint is the idempotency key, so two
 * concurrent opens of the same wallet end with one row and both callers holding it.
 * Only a genuinely new account writes an audit row.
 */
export async function openAccount(db: DbOrTx, input: OpenAccountInput): Promise<OpenedAccount> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(accounts)
      .values({
        id: newId('acct'),
        tenantId: input.tenantId,
        kind: input.kind,
        ownerRef: input.ownerRef,
        asset: input.asset,
        normalSide: NORMAL_SIDE_BY_KIND[input.kind],
      })
      .onConflictDoNothing({ target: [accounts.tenantId, accounts.kind, accounts.ownerRef, accounts.asset] })
      .returning();

    if (inserted !== undefined) {
      await recordAudit(tx, {
        tenantId: input.tenantId,
        actor: input.actor ?? SYSTEM_ACTOR,
        action: 'account.opened',
        subject: inserted.id,
        before: null,
        after: inserted,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      });
      return { account: inserted, created: true };
    }

    const existing = await findAccount(tx, input);
    if (existing === undefined) {
      throw new Error(`Account (${input.kind}, ${input.ownerRef ?? 'null'}, ${input.asset}) was neither inserted nor found`);
    }
    return { account: existing, created: false };
  });
}

/** Look an account up by its natural key. */
export async function findAccount(
  db: DbOrTx,
  key: { tenantId: Id<'tnt'>; kind: AccountKind; ownerRef: string | null; asset: Asset },
): Promise<Account | undefined> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.tenantId, key.tenantId),
        eq(accounts.kind, key.kind),
        key.ownerRef === null ? isNull(accounts.ownerRef) : eq(accounts.ownerRef, key.ownerRef),
        eq(accounts.asset, key.asset),
      ),
    );
  return row;
}

/** Load an account by id, or throw `account_not_found`. */
export async function getAccount(db: DbOrTx, accountId: string): Promise<Account> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (row === undefined) throw new LedgerError('account_not_found', `No account ${accountId}`, { accountId });
  return row;
}
