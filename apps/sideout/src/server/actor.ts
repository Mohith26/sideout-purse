import { randomBytes } from 'node:crypto';

import type { ActorKind, User } from '../db/schema';

/** Who is performing a change, as the audit log records it. */
export type Actor = { kind: 'player' | 'organizer'; userId: string } | { kind: 'system'; userId: null };

export const SYSTEM_ACTOR: Actor = { kind: 'system', userId: null };

export function actorFor(user: User): Actor {
  return { kind: user.role, userId: user.id };
}

export function actorKind(actor: Actor): ActorKind {
  return actor.kind;
}

/**
 * The opaque ids Sideout mints for Purse: a user's `external_id` and a tournament's
 * contest `external_id` (spec 4.1: "the partner's opaque id"). Random, never derived from
 * a phone number, a name or a Sideout id, so Purse learns nothing from it.
 */
export function mintPurseExternalId(kind: 'user' | 'contest'): string {
  return `sideout-${kind}-${randomBytes(16).toString('hex')}`;
}
