import { newId } from '@repo/ids';

import { auditLog, type AuditLogEntry } from '../db/schema';
import type { Actor } from './actor';
import type { DbOrTx } from './db';

export type AuditInput = {
  actor: Actor;
  action: string;
  subjectType: 'tournament' | 'team' | 'match' | 'donation' | 'user' | 'purse_event';
  subjectId: string;
  detail: Record<string, unknown>;
  at: Date;
};

/**
 * Append one audit row. Always called on the transaction that performs the change it
 * records, so a change and its audit trail commit or roll back together.
 */
export async function writeAudit(tx: DbOrTx, input: AuditInput): Promise<AuditLogEntry> {
  const [row] = await tx
    .insert(auditLog)
    .values({
      id: newId('aud'),
      actorKind: input.actor.kind,
      actorUserId: input.actor.userId,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      detail: input.detail,
      createdAt: input.at,
    })
    .returning();
  if (row === undefined) throw new Error('audit: insert returned no row');
  return row;
}
