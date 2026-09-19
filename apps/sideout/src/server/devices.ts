import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { ecPublicJwkSchema, jwkThumbprint, type EcPublicJwk } from '@purse/types';
import { newId } from '@repo/ids';
import { z } from 'zod';

import type { Db } from '../db/client';
import { teamDevices, teamMembers, teams, tournaments, users, type TeamDevice, type User } from '../db/schema';
import { DEVICE_AUDIT, type DeviceView } from '../domain/attestation';
import { describeFailure, isPurseFailure } from '../purse';
import { actorFor, SYSTEM_ACTOR } from './actor';
import { writeAudit } from './audit';
import type { AppContext } from './context';
import type { DbOrTx } from './db';
import { COUNTED_TEAM_STATUSES } from './field';
import { failure } from './http/errors';
import { requirePurse, type PurseDeps } from './purse/deps';

/**
 * Team devices (spec section 12, item 1; `docs/attestation.md`): the phones a team checked
 * in, whose signatures the score route accepts. A member registers their own phone's
 * public key for their team (the key id is the JWK thumbprint, computed here, never taken
 * from the phone); the organizer revokes one; and every live key is mirrored to Purse for
 * the member's linked user after the registration commits, so Purse can verify a score
 * against a copy Sideout never touched again. A mirror that fails is audited and reported,
 * never fatal: the next registration or the push's retry runs it again.
 */
export const registerDeviceSchema = z.strictObject({
  publicKey: z.record(z.string().max(16), z.string().max(128)),
});

/** Team statuses whose members may check a phone in: a team that holds, or held, a place. */
const CHECK_IN_TEAM_STATUSES: ReadonlySet<string> = new Set(COUNTED_TEAM_STATUSES);
/** Tournament statuses in which a check-in makes sense: from registration until play ends. */
const CHECK_IN_TOURNAMENT_STATUSES: ReadonlySet<string> = new Set(['registration_open', 'registration_closed', 'live']);

export async function registerTeamDevice(db: Db, input: { teamId: string; user: User; publicKey: unknown; now: Date }): Promise<{ device: TeamDevice; created: boolean }> {
  const parsed = ecPublicJwkSchema.safeParse(input.publicKey);
  if (!parsed.success) throw failure.invalidRequest('invalid_public_key', 'The device key must be a P-256 public JWK (kty EC, crv P-256, x, y) and nothing else.');
  const publicKey: EcPublicJwk = parsed.data;
  const keyId = await jwkThumbprint(publicKey);
  const { now, user } = input;
  return db.transaction(async (tx) => {
    const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId)).for('update');
    if (team === undefined) throw failure.notFound('team_not_found', 'No such team.');
    const [member] = await tx.select().from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, user.id)));
    if (member === undefined) throw failure.permission('not_on_team', 'Only a member of the team can check a phone in for it.');
    const [tournament] = await tx.select({ status: tournaments.status, name: tournaments.name }).from(tournaments).where(eq(tournaments.id, team.tournamentId));
    if (tournament === undefined) throw failure.notFound('tournament_not_found', 'No such tournament.');
    if (!CHECK_IN_TEAM_STATUSES.has(team.status)) {
      throw failure.invalidState('team_not_registered', `${team.name} is ${team.status.replace('_', ' ')}; a phone is checked in once the team is registered.`);
    }
    if (!CHECK_IN_TOURNAMENT_STATUSES.has(tournament.status)) {
      throw failure.invalidState('check_in_closed', `${tournament.name} is ${tournament.status.replace('_', ' ')}; phones are checked in from registration until play ends.`);
    }
    const [existing] = await tx
      .select()
      .from(teamDevices)
      .where(and(eq(teamDevices.teamId, team.id), eq(teamDevices.keyId, keyId), isNull(teamDevices.revokedAt)))
      .for('update');
    if (existing !== undefined) return { device: existing, created: false };
    const [device] = await tx
      .insert(teamDevices)
      .values({ id: newId('dev'), teamId: team.id, userId: user.id, keyId, algorithm: 'ES256', publicKey, createdAt: now, updatedAt: now })
      .returning();
    if (device === undefined) throw new Error('team_devices insert returned no row');
    await writeAudit(tx, {
      actor: actorFor(user),
      action: DEVICE_AUDIT.registered,
      subjectType: 'team',
      subjectId: team.id,
      detail: { deviceId: device.id, userId: user.id, keyId, algorithm: 'ES256' },
      at: now,
    });
    return { device, created: true };
  });
}

export async function revokeTeamDevice(db: Db, input: { deviceId: string; organizer: User; reason: string | null; now: Date }): Promise<{ device: TeamDevice; revoked: boolean }> {
  if (input.organizer.role !== 'organizer') throw failure.permission('organizer_required', 'Only an organizer can revoke a device.');
  const { now } = input;
  return db.transaction(async (tx) => {
    const [device] = await tx.select().from(teamDevices).where(eq(teamDevices.id, input.deviceId)).for('update');
    if (device === undefined) throw failure.notFound('device_not_found', 'No such device.');
    if (device.revokedAt !== null) return { device, revoked: false };
    const [updated] = await tx
      .update(teamDevices)
      .set({ revokedAt: now, revokedByUserId: input.organizer.id, revokedReason: input.reason, updatedAt: now })
      .where(eq(teamDevices.id, device.id))
      .returning();
    if (updated === undefined) throw new Error('team_devices update returned no row');
    await writeAudit(tx, {
      actor: actorFor(input.organizer),
      action: DEVICE_AUDIT.revoked,
      subjectType: 'team',
      subjectId: device.teamId,
      detail: { deviceId: device.id, userId: device.userId, keyId: device.keyId, reason: input.reason },
      at: now,
    });
    return { device: updated, revoked: true };
  });
}

/** Every device ever checked in for the given teams, oldest first; revoked rows included so the organizer sees the history. */
export async function listTeamDevices(db: DbOrTx, teamIds: readonly string[]): Promise<TeamDevice[]> {
  if (teamIds.length === 0) return [];
  return db
    .select()
    .from(teamDevices)
    .where(inArray(teamDevices.teamId, [...teamIds]))
    .orderBy(asc(teamDevices.createdAt), asc(teamDevices.id));
}

/** The live (unrevoked) device of a team under a key id, or the revoked one if that is all there is, or null. */
export async function findTeamDevice(db: DbOrTx, teamId: string, keyId: string): Promise<TeamDevice | null> {
  const rows = await db
    .select()
    .from(teamDevices)
    .where(and(eq(teamDevices.teamId, teamId), eq(teamDevices.keyId, keyId)))
    .orderBy(asc(teamDevices.createdAt), asc(teamDevices.id));
  return rows.find((row) => row.revokedAt === null) ?? rows.at(-1) ?? null;
}

export function deviceView(device: TeamDevice): DeviceView {
  return {
    id: device.id,
    teamId: device.teamId,
    userId: device.userId,
    keyId: device.keyId,
    algorithm: 'ES256',
    publicKey: device.publicKey,
    registeredAt: device.createdAt.toISOString(),
    revokedAt: device.revokedAt?.toISOString() ?? null,
    revokedReason: device.revokedReason,
    mirrored: device.purseDeviceId !== null,
  };
}

// ---- The Purse mirror ------------------------------------------------------------------------

export type MirrorReport = { status: 'mirrored' | 'skipped' | 'failed' | 'unavailable'; reason?: string };

/**
 * Register the device's key with Purse for the member's linked user, after Sideout's own
 * row committed. A member who has not linked a Purse account yet has nothing to mirror to
 * (`skipped`); the link route mirrors any waiting device once they do. Purse keys the
 * registration by (user, key), so a repeat is a no-op there too.
 */
export async function mirrorDeviceToPurse(deps: PurseDeps, device: TeamDevice, input: { requestId: string; now: Date }): Promise<MirrorReport> {
  const [owner] = await deps.db.select({ purseUserId: users.purseUserId }).from(users).where(eq(users.id, device.userId));
  if (owner?.purseUserId === null || owner?.purseUserId === undefined) return { status: 'skipped', reason: 'The player has not linked a Purse account yet; the key is mirrored when they do.' };
  const subject = { type: 'team' as const, id: device.teamId };
  try {
    const registered = await deps.purse.registerDevice(owner.purseUserId, { publicKey: device.publicKey, label: `sideout:${device.teamId}` }, { requestId: input.requestId, idempotencyKey: `sideout:device:${device.id}:register`, subject });
    await deps.db.transaction(async (tx) => {
      await tx.update(teamDevices).set({ purseDeviceId: registered.data.id, purseMirroredAt: input.now, updatedAt: input.now }).where(eq(teamDevices.id, device.id));
      await writeAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: DEVICE_AUDIT.mirrored,
        subjectType: 'team',
        subjectId: device.teamId,
        detail: { deviceId: device.id, purseDeviceId: registered.data.id, purseUserId: owner.purseUserId, created: registered.status === 201 },
        at: input.now,
      });
    });
    return { status: 'mirrored' };
  } catch (error) {
    if (!isPurseFailure(error)) throw error;
    const described = describeFailure(error, input.now);
    await writeAudit(deps.db, {
      actor: SYSTEM_ACTOR,
      action: DEVICE_AUDIT.mirrorFailed,
      subjectType: 'team',
      subjectId: device.teamId,
      detail: { deviceId: device.id, purseUserId: owner.purseUserId, error: described },
      at: input.now,
    });
    return { status: 'failed', reason: described.message };
  }
}

/**
 * Tell Purse a device is revoked, unless the same key is still live for the member on
 * another team (Purse holds one registration per user and key); then Purse keeps it.
 */
export async function mirrorRevocationToPurse(deps: PurseDeps, device: TeamDevice, input: { requestId: string; now: Date }): Promise<MirrorReport> {
  if (device.purseDeviceId === null) return { status: 'skipped', reason: 'The key was never mirrored to Purse.' };
  const [owner] = await deps.db.select({ purseUserId: users.purseUserId }).from(users).where(eq(users.id, device.userId));
  if (owner?.purseUserId === null || owner?.purseUserId === undefined) return { status: 'skipped', reason: 'The player is not linked to Purse.' };
  const stillLive = await deps.db
    .select({ id: teamDevices.id })
    .from(teamDevices)
    .where(and(eq(teamDevices.userId, device.userId), eq(teamDevices.keyId, device.keyId), isNull(teamDevices.revokedAt)))
    .limit(1);
  if (stillLive.length > 0) return { status: 'skipped', reason: 'The same key is still checked in for another of the player’s teams.' };
  try {
    await deps.purse.revokeDevice(owner.purseUserId, device.purseDeviceId, { reason: device.revokedReason ?? 'revoked by the organizer' }, { requestId: input.requestId, idempotencyKey: `sideout:device:${device.id}:revoke`, subject: { type: 'team', id: device.teamId } });
    return { status: 'mirrored' };
  } catch (error) {
    if (!isPurseFailure(error)) throw error;
    const described = describeFailure(error, input.now);
    await writeAudit(deps.db, {
      actor: SYSTEM_ACTOR,
      action: DEVICE_AUDIT.mirrorFailed,
      subjectType: 'team',
      subjectId: device.teamId,
      detail: { deviceId: device.id, purseDeviceId: device.purseDeviceId, revoke: true, error: described },
      at: input.now,
    });
    return { status: 'failed', reason: described.message };
  }
}

/** Mirror every live, unmirrored device of a user: called when they link their Purse account. */
export async function mirrorPendingDevices(deps: PurseDeps, userId: string, input: { requestId: string; now: Date }): Promise<MirrorReport[]> {
  const pending = await deps.db
    .select()
    .from(teamDevices)
    .where(and(eq(teamDevices.userId, userId), isNull(teamDevices.revokedAt), isNull(teamDevices.purseDeviceId)))
    .orderBy(asc(teamDevices.createdAt));
  const reports: MirrorReport[] = [];
  for (const device of pending) reports.push(await mirrorDeviceToPurse(deps, device, input));
  return reports;
}

/** A route's mirror step: never fatal, reported in the answer. */
export async function mirrorAfterCommit(app: AppContext, run: (deps: PurseDeps) => Promise<MirrorReport>): Promise<MirrorReport> {
  if (app.purse === null) return { status: 'unavailable', reason: 'Purse is not configured on this server.' };
  try {
    return await run(requirePurse(app));
  } catch (error) {
    app.log.error('device mirror failed unexpectedly', { message: error instanceof Error ? error.message : String(error) });
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
