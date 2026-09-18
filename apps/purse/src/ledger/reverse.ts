import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { JournalEntryKind } from '../db/schema';
import { LedgerError } from './errors';
import { getTenantEntry, linesOf, postEntry, type PostedEntry } from './post';
import { mirrorDirection } from './validate';

export type ReverseEntryInput = {
  /** The tenant acting. An entry of another tenant is refused with `entry_wrong_tenant`. */
  tenantId: Id<'tnt'>;
  entryId: Id<'je'>;
  idempotencyKey: string;
  /** `reversal` for a plain correction; `void` when a contest entry is being unwound. */
  kind?: Extract<JournalEntryKind, 'reversal' | 'void'>;
  description?: string;
};

/**
 * Spec 4.2.2 rule 6: the only way to correct history. Posts the mirror image of an entry
 * (every line flipped) with `reverses_entry_id` set. Goes through `postEntry`, so it is
 * idempotent, balanced by construction, refused if the entry was already reversed, and
 * refused if undoing the entry would take a wallet below zero. The tenant is checked here,
 * at the ledger boundary, so no caller can reverse another tenant's entry by id alone.
 */
export async function reverseEntry(db: DbOrTx, input: ReverseEntryInput): Promise<PostedEntry> {
  return db.transaction(async (tx) => {
    const original = await getTenantEntry(tx, input.tenantId, input.entryId);
    const lines = await linesOf(tx, original.id);
    if (lines.length === 0) {
      throw new LedgerError('not_reversible', `Entry ${original.id} has no lines to reverse`, { entryId: original.id });
    }
    return postEntry(tx, {
      tenantId: input.tenantId,
      kind: input.kind ?? 'reversal',
      description: input.description ?? `Reversal of ${original.id}: ${original.description}`,
      idempotencyKey: input.idempotencyKey,
      contestId: original.contestId as Id<'cnt'> | null,
      reversesEntryId: original.id as Id<'je'>,
      lines: lines.map((line) => ({
        accountId: line.accountId,
        direction: mirrorDirection(line.direction),
        amount: line.amount,
        asset: line.asset,
      })),
    });
  });
}
