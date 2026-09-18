import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { auditLog, type AuditActorKind } from '../db/schema';

/** Who caused a state transition. Defaults to the platform itself. */
export type Actor = { kind: AuditActorKind; ref?: string };

export const SYSTEM_ACTOR: Actor = { kind: 'system' };

export type AuditEvent = {
  tenantId: Id<'tnt'> | null;
  actor: Actor;
  /** Dotted, past tense: `account.opened`, `account.frozen`. */
  action: string;
  /** The typed id of what changed, or a stable name when there is no row. */
  subject: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId?: string;
};

/**
 * Append one audit row inside the caller's transaction so it commits with the change it
 * describes. Bigints are written as decimal strings; jsonb has no integer type wide
 * enough and a float would be a spec violation.
 */
export async function recordAudit(tx: DbOrTx, event: AuditEvent): Promise<Id<'aud'>> {
  const id = newId('aud');
  await tx.insert(auditLog).values({
    id,
    tenantId: event.tenantId,
    actorKind: event.actor.kind,
    actorRef: event.actor.ref ?? null,
    action: event.action,
    subject: event.subject,
    before: event.before === null ? null : jsonSafe(event.before),
    after: event.after === null ? null : jsonSafe(event.after),
    requestId: event.requestId ?? null,
  });
  return id;
}

export function jsonSafe(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner)),
  ) as Record<string, unknown>;
}
