import { eq, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { userLocations, type User, type UserLocation } from '../db/schema';
import { recordAudit, type Actor } from '../ledger/audit';
import type { GeoProvider, GeoResolution } from '../providers/types';

/**
 * Locations (spec 4.1 `user_locations`): where the user is, as the `GeoProvider` seam
 * last resolved it. A request that carries a declared region or the end user's address
 * goes through the provider; a resolution with no region records nothing (the previous
 * one, if any, stands) and the evaluator sees `region: null` when there is none.
 */
export type LocationInput = { declaredRegion?: string | null | undefined; ip?: string | null | undefined };

export type RecordLocationInput = {
  user: User;
  location: LocationInput;
  geo: GeoProvider;
  actor: Actor;
  requestId?: string;
  now?: Date;
};

export type RecordedLocation = { resolution: GeoResolution; location: UserLocation | null };

/** Ask the seam. A vendor call: never made while a transaction, a lock or a pool connection is held. */
export function resolveLocation(geo: GeoProvider, location: LocationInput): Promise<GeoResolution> {
  return geo.resolve({ declaredRegion: location.declaredRegion ?? null, ip: location.ip ?? null });
}

export async function resolveAndRecordLocation(db: DbOrTx, input: RecordLocationInput): Promise<RecordedLocation> {
  const resolution = await resolveLocation(input.geo, input.location);
  return recordResolvedLocation(db, { user: input.user, resolution, actor: input.actor, ...(input.requestId === undefined ? {} : { requestId: input.requestId }), ...(input.now === undefined ? {} : { now: input.now }) });
}

export type RecordResolvedInput = Omit<RecordLocationInput, 'location' | 'geo'> & { resolution: GeoResolution };

/** Store what the seam answered; a resolution with no region records nothing. */
export async function recordResolvedLocation(db: DbOrTx, input: RecordResolvedInput): Promise<RecordedLocation> {
  const { resolution } = input;
  const region = resolution.region;
  if (region === null) return { resolution, location: null };
  const location = await recordLocation(db, { user: input.user, resolution: { ...resolution, region }, actor: input.actor, ...(input.requestId === undefined ? {} : { requestId: input.requestId }), ...(input.now === undefined ? {} : { now: input.now }) });
  return { resolution, location };
}

export type StoreLocationInput = {
  user: User;
  resolution: GeoResolution & { region: string };
  actor: Actor;
  requestId?: string;
  now?: Date;
};

export async function recordLocation(db: DbOrTx, input: StoreLocationInput): Promise<UserLocation> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(userLocations).where(eq(userLocations.userId, input.user.id));
    const [after] = await tx
      .insert(userLocations)
      .values({ userId: input.user.id, regionCode: input.resolution.region, source: input.resolution.source, resolvedAt: now, confidence: input.resolution.confidence })
      .onConflictDoUpdate({
        target: userLocations.userId,
        set: { regionCode: input.resolution.region, source: input.resolution.source, resolvedAt: now, confidence: input.resolution.confidence, updatedAt: sql`now()` },
      })
      .returning();
    if (after === undefined) throw new Error('user_locations upsert returned no row');
    if (before?.regionCode !== after.regionCode || before.source !== after.source) {
      await recordAudit(tx, {
        tenantId: input.user.tenantId as Id<'tnt'>,
        actor: input.actor,
        action: 'user.location.resolved',
        subject: input.user.id,
        before: before ?? null,
        after,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      });
    }
    return after;
  });
}

export async function locationOf(db: DbOrTx, userId: string): Promise<UserLocation | undefined> {
  const [row] = await db.select().from(userLocations).where(eq(userLocations.userId, userId));
  return row;
}
