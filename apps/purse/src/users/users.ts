import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isId, newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { userVerification, users, type OperatorFlag, type User, type UserVerification } from '../db/schema';
import { regionCodeSchema } from '../eligibility/ruleset';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import type { GeoProvider, GeoResolution } from '../providers/types';
import { UsersError } from './errors';
import { refreshFingerprint } from './fingerprint';
import { recordResolvedLocation, resolveLocation } from './locations';

/**
 * Users (spec 4.1, decision D8): Purse owns the wallet-bearing identity and the partner
 * links to it by `external_id`. `upsertUser` is `POST /users`: it creates the user on the
 * first call and corrects the demographics on later ones, under a row lock so two racing
 * upserts of one external id end with one row. Every write recomputes the identity
 * fingerprint (spec 4.6) and records a location when the request carries one; the geo
 * seam is asked before the transaction opens, so a vendor call never holds the lock.
 */
const PHONE_E164 = /^\+[1-9][0-9]{6,14}$/;

const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'must be a real calendar date')
  .refine((value) => value >= '1900-01-01', 'must be on or after 1900-01-01')
  .refine((value) => value <= new Date().toISOString().slice(0, 10), 'must not be in the future');

export const locationInputSchema = z
  .object({
    declaredRegion: regionCodeSchema.nullable().optional(),
    ip: z.union([z.ipv4(), z.ipv6()]).nullable().optional(),
  })
  .strict();

export const upsertUserSchema = z
  .object({
    externalId: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(200).nullable().optional(),
    phoneE164: z.string().regex(PHONE_E164, 'must be E.164, +14155550123').nullable().optional(),
    dateOfBirth: dateOfBirth.nullable().optional(),
    /** What the partner knows of where the user is; resolved through the `GeoProvider` seam. */
    location: locationInputSchema.optional(),
  })
  .strict();

export type UpsertUserFields = z.input<typeof upsertUserSchema>;

export type UpsertUserInput = UpsertUserFields & {
  tenantId: Id<'tnt'>;
  actor?: Actor;
  requestId?: string;
  /** Needed only when the request carries a `location`. */
  geo?: GeoProvider;
};

export type UpsertedUser = {
  user: User;
  verification: UserVerification;
  created: boolean;
  /** Duplicate-identity flags this write raised (spec 4.6). */
  flags: OperatorFlag[];
};

export async function upsertUser(db: DbOrTx, input: UpsertUserInput): Promise<UpsertedUser> {
  const { tenantId, actor, requestId, geo, ...fields } = input;
  const parsed = parse(upsertUserSchema, fields);
  const who = actor ?? SYSTEM_ACTOR;
  const audit = requestId === undefined ? {} : { requestId };

  let resolution: GeoResolution | undefined;
  if (parsed.location !== undefined) {
    if (geo === undefined) throw new UsersError('invalid_input', 'a location was given but no geolocation provider is configured', { field: 'location' });
    resolution = await resolveLocation(geo, parsed.location);
  }

  return db.transaction(async (tx) => {
    // Two racing upserts of one external id serialise here and the second sees the first's row.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user:${tenantId}:${parsed.externalId}`}, 0))`);
    const [existing] = await tx
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.externalId, parsed.externalId)))
      .for('update');

    let user: User;
    let created = false;
    if (existing === undefined) {
      const [inserted] = await tx
        .insert(users)
        .values({
          id: newId('usr'),
          tenantId,
          externalId: parsed.externalId,
          displayName: parsed.displayName ?? null,
          phoneE164: parsed.phoneE164 ?? null,
          dateOfBirth: parsed.dateOfBirth ?? null,
        })
        .returning();
      if (inserted === undefined) throw new Error('users insert returned no row');
      user = inserted;
      created = true;
      await tx.insert(userVerification).values({ userId: user.id }).onConflictDoNothing({ target: userVerification.userId });
      await recordAudit(tx, { tenantId, actor: who, action: 'user.created', subject: user.id, before: null, after: user, ...audit });
    } else {
      const patch = {
        ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
        ...(parsed.phoneE164 === undefined ? {} : { phoneE164: parsed.phoneE164 }),
        ...(parsed.dateOfBirth === undefined ? {} : { dateOfBirth: parsed.dateOfBirth }),
      };
      const changed = Object.entries(patch).some(([key, value]) => existing[key as keyof typeof patch] !== value);
      if (changed) {
        const [updated] = await tx
          .update(users)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(eq(users.id, existing.id))
          .returning();
        if (updated === undefined) throw new Error(`users update of ${existing.id} returned no row`);
        user = updated;
        await recordAudit(tx, { tenantId, actor: who, action: 'user.updated', subject: user.id, before: existing, after: user, ...audit });
      } else {
        user = existing;
      }
    }

    const { flags } = await refreshFingerprint(tx, user);
    if (resolution !== undefined) await recordResolvedLocation(tx, { user, resolution, actor: who, ...audit });
    const verification = await getVerification(tx, user.id);
    return { user, verification, created, flags };
  });
}

/** A user by id that must belong to `tenantId`, or `user_not_found` / `user_wrong_tenant`. */
export async function getUser(db: DbOrTx, tenantId: Id<'tnt'>, userId: string): Promise<User> {
  if (!isId(userId, 'usr')) throw new UsersError('invalid_input', 'userId must be a usr_ id', { field: 'userId' });
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (row === undefined) throw new UsersError('user_not_found', `No user ${userId}`, { userId });
  if (row.tenantId !== tenantId) throw new UsersError('user_wrong_tenant', `User ${userId} belongs to another tenant`, { userId });
  return row;
}

/** The verification row, which exists for every user from creation. */
export async function getVerification(db: DbOrTx, userId: string): Promise<UserVerification> {
  const [row] = await db.select().from(userVerification).where(eq(userVerification.userId, userId));
  if (row === undefined) throw new Error(`user_verification row for ${userId} is missing`);
  return row;
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String).join('.') ?? '';
    throw new UsersError('invalid_input', `Invalid ${path === '' ? 'input' : path}: ${issue?.message ?? 'unknown'}`, {
      path,
      issues: result.error.issues.map((each) => ({ path: each.path.map(String).join('.'), message: each.message })),
    });
  }
  return result.data;
}
