import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import type { User, UserLocation, UserRestriction, UserVerification } from '../db/schema';
import { locationOf } from './locations';
import { activeRestrictions } from './restrictions';
import { getUser, getVerification } from './users';

/** Everything the API returns about a user, and everything the eligibility engine reads about one. */
export type UserProfile = {
  user: User;
  verification: UserVerification;
  /** In force at `now`. */
  restrictions: UserRestriction[];
  location: UserLocation | undefined;
};

export async function loadProfile(db: DbOrTx, tenantId: Id<'tnt'>, userId: string, now: Date = new Date()): Promise<UserProfile> {
  const user = await getUser(db, tenantId, userId);
  return profileOf(db, user, now);
}

export async function profileOf(db: DbOrTx, user: User, now: Date = new Date()): Promise<UserProfile> {
  const [verification, restrictions, location] = await Promise.all([getVerification(db, user.id), activeRestrictions(db, user.id, now), locationOf(db, user.id)]);
  return { user, verification, restrictions, location };
}
