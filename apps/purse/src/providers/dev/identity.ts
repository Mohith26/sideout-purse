import { createHash } from 'node:crypto';

import type { IdentityCheckRequest, IdentityProvider, VerificationResult } from '../types';

/**
 * The dev identity provider: verifies deterministically from a seeded allow/deny list
 * (spec 4.5). This is where Persona or Socure would plug in; a real provider would open a
 * hosted inquiry inside the embed iframe and complete it through a webhook.
 *
 * The rule, in order:
 *   1. an external id on the deny list is `rejected`;
 *   2. one on the pending list stays `pending` (so a demo can show the waiting state);
 *   3. one on the allow list is `verified`;
 *   4. anyone else is `verified` when a display name and a date of birth were supplied,
 *      which is what a real check needs, and `rejected` otherwise.
 *
 * The provider reference is a digest of the user id and outcome, so a replay of the same
 * check yields the same reference, and never anything about the user.
 */
export type DevIdentityLists = {
  allow?: readonly string[];
  deny?: readonly string[];
  pending?: readonly string[];
};

export const DEV_IDENTITY_PROVIDER_NAME = 'dev';

export function devIdentityProvider(lists: DevIdentityLists = {}): IdentityProvider {
  const allow = new Set(lists.allow ?? []);
  const deny = new Set(lists.deny ?? []);
  const pending = new Set(lists.pending ?? []);
  return {
    name: DEV_IDENTITY_PROVIDER_NAME,
    verify(user: IdentityCheckRequest): Promise<VerificationResult> {
      const outcome = decide(user, { allow, deny, pending });
      const providerRef = `dev-${createHash('sha256').update(`${user.userId}|${outcome.outcome}`).digest('hex').slice(0, 24)}`;
      return Promise.resolve({ ...outcome, providerRef });
    },
  };
}

function decide(user: IdentityCheckRequest, lists: { allow: Set<string>; deny: Set<string>; pending: Set<string> }): Omit<VerificationResult, 'providerRef'> {
  if (lists.deny.has(user.externalId)) return { outcome: 'rejected', note: 'external id is on the dev deny list' };
  if (lists.pending.has(user.externalId)) return { outcome: 'pending', note: 'external id is on the dev pending list' };
  if (lists.allow.has(user.externalId)) return { outcome: 'verified', note: 'external id is on the dev allow list' };
  if (user.displayName === null || user.displayName.trim() === '' || user.dateOfBirth === null) {
    return { outcome: 'rejected', note: 'a display name and a date of birth are required' };
  }
  return { outcome: 'verified', note: 'demographics supplied' };
}
