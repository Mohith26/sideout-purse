import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, type Id } from '@repo/ids';

import { consumeEmbedToken } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { auditLog, identityFingerprints, operatorFlags, userLocations, userVerification, users } from '../../src/db/schema';
import { devGeoProvider, devIdentityProvider, type IdentityProvider } from '../../src/providers';
import {
  activeRestrictions,
  addRestriction,
  getUser,
  identityFingerprint,
  isUsersError,
  liftRestriction,
  loadProfile,
  normalizeName,
  startVerification,
  upsertUser,
} from '../../src/users';
import { connectMigrator, connectRuntime, rejection } from '../helpers';
import { createTenant, createUser, wipeLedger } from '../ledger/fixtures';

/**
 * Spec 4.1 identity: users linked by external id, the verification state machine (never
 * a document), restrictions irreversible by the user, locations through the geo seam, and
 * the duplicate-identity fingerprint of spec 4.6.
 */
describe('users', () => {
  let migrator: Database;
  let runtime: Database;
  let tenantId: Id<'tnt'>;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    tenantId = await createTenant(runtime.db);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('creates on the first upsert, corrects demographics on the next, and never changes the identity fields', async () => {
    const first = await upsertUser(runtime.db, { tenantId, externalId: 'sideout:u1', displayName: 'Ana Reyes', dateOfBirth: '1994-03-12', phoneE164: '+15125550101', actor: { kind: 'tenant', ref: 'key_1' }, requestId: 'req-1' });
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({ tenantId, externalId: 'sideout:u1', displayName: 'Ana Reyes', dateOfBirth: '1994-03-12', phoneE164: '+15125550101' });
    expect(first.user.id).toMatch(/^usr_/);
    expect(first.verification).toMatchObject({ userId: first.user.id, state: 'unstarted', provider: null, providerRef: null, verifiedAt: null });

    const second = await upsertUser(runtime.db, { tenantId, externalId: 'sideout:u1', displayName: 'Ana M. Reyes', phoneE164: null });
    expect(second.created).toBe(false);
    expect(second.user).toMatchObject({ id: first.user.id, displayName: 'Ana M. Reyes', phoneE164: null, dateOfBirth: '1994-03-12' });
    const unchanged = await upsertUser(runtime.db, { tenantId, externalId: 'sideout:u1' });
    expect(unchanged.user).toEqual(second.user);
    expect(await runtime.db.select().from(users)).toHaveLength(1);

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, first.user.id));
    expect(audit.map((row) => row.action)).toEqual(['user.created', 'user.updated']);
    expect(audit[0]).toMatchObject({ actorKind: 'tenant', actorRef: 'key_1', requestId: 'req-1' });

    // External id and tenant are fixed for every role.
    const rename = await rejection(migrator.sql`update users set external_id = 'other' where id = ${first.user.id}`);
    expect(String(rename)).toMatch(/identity fields cannot change/);
    const move = await rejection(runtime.sql`update users set tenant_id = ${newId('tnt')} where id = ${first.user.id}`);
    expect(String(move)).toMatch(/permission denied for table users/);
    const del = await rejection(runtime.sql`delete from users where id = ${first.user.id}`);
    expect(String(del)).toMatch(/permission denied for table users/);
  });

  it('validates what a partner sends and keys by tenant', async () => {
    for (const [name, fields] of [
      ['a blank external id', { externalId: '  ' }],
      ['a bad phone', { externalId: 'x', phoneE164: '555-0101' }],
      ['a bad date', { externalId: 'x', dateOfBirth: '1994-3-2' }],
      ['an impossible date', { externalId: 'x', dateOfBirth: '1994-02-30' }],
      ['a future date', { externalId: 'x', dateOfBirth: '2099-01-01' }],
      ['a region that is not a code', { externalId: 'x', location: { declaredRegion: 'Texas' } }],
      ['an unknown field', { externalId: 'x', email: 'a@b.c' }],
    ] as const) {
      const error = await rejection(upsertUser(runtime.db, { tenantId, ...(fields as { externalId: string }) }));
      expect(isUsersError(error, 'invalid_input'), name).toBe(true);
    }
    const other = await createTenant(runtime.db);
    const mine = await upsertUser(runtime.db, { tenantId, externalId: 'shared-id' });
    const theirs = await upsertUser(runtime.db, { tenantId: other, externalId: 'shared-id' });
    expect(theirs.user.id).not.toBe(mine.user.id);
    const stranger = await rejection(getUser(runtime.db, other, mine.user.id));
    expect(isUsersError(stranger, 'user_wrong_tenant')).toBe(true);
    const missing = await rejection(getUser(runtime.db, tenantId, newId('usr')));
    expect(isUsersError(missing, 'user_not_found')).toBe(true);
    const malformed = await rejection(getUser(runtime.db, tenantId, 'usr_nope'));
    expect(isUsersError(malformed, 'invalid_input')).toBe(true);
  });

  it('fingerprints the normalised name and date of birth and flags collisions once per pair', async () => {
    expect(normalizeName('  José  ÁLVAREZ-Núñez ')).toBe('josealvareznunez');
    expect(identityFingerprint('Jose Alvarez Nunez', '1990-01-01')).toBe(identityFingerprint('josé álvarez-núñez', '1990-01-01'));
    expect(identityFingerprint('Jose Alvarez Nunez', '1990-01-01')).not.toBe(identityFingerprint('Jose Alvarez Nunez', '1990-01-02'));

    const a = await upsertUser(runtime.db, { tenantId, externalId: 'a', displayName: 'Jose Alvarez', dateOfBirth: '1990-01-01' });
    expect(a.flags).toEqual([]);
    const b = await upsertUser(runtime.db, { tenantId, externalId: 'b', displayName: 'JOSÉ  Álvarez', dateOfBirth: '1990-01-01' });
    expect(b.flags).toHaveLength(1);
    expect(b.flags[0]).toMatchObject({ kind: 'duplicate_identity', status: 'open', tenantId });
    expect(b.flags[0]?.detail).toMatchObject({ users: [a.user.id, b.user.id].sort() });
    // A rerun, a third collision, and a user missing a date of birth.
    expect((await upsertUser(runtime.db, { tenantId, externalId: 'b' })).flags).toEqual([]);
    const c = await upsertUser(runtime.db, { tenantId, externalId: 'c', displayName: 'Jose Alvarez', dateOfBirth: '1990-01-01' });
    expect(c.flags).toHaveLength(2);
    const incomplete = await upsertUser(runtime.db, { tenantId, externalId: 'd', displayName: 'Jose Alvarez' });
    expect(incomplete.flags).toEqual([]);
    expect(await runtime.db.select().from(operatorFlags)).toHaveLength(3);
    // Clearing the date of birth voids the fingerprint rather than leaving a matching one behind.
    await upsertUser(runtime.db, { tenantId, externalId: 'c', dateOfBirth: null });
    const [voided] = await runtime.db.select().from(identityFingerprints).where(eq(identityFingerprints.userId, c.user.id));
    expect(voided?.fingerprint).not.toBe(identityFingerprint('Jose Alvarez', '1990-01-01'));
    // Another tenant's identical person is not this tenant's business.
    const other = await createTenant(runtime.db);
    expect((await upsertUser(runtime.db, { tenantId: other, externalId: 'a', displayName: 'Jose Alvarez', dateOfBirth: '1990-01-01' })).flags).toEqual([]);
  });

  it('resolves a declared region or an address through the geo seam and records the current location', async () => {
    const geo = devGeoProvider();
    const declared = await upsertUser(runtime.db, { tenantId, externalId: 'loc', location: { declaredRegion: 'US-TX' }, geo });
    let profile = await loadProfile(runtime.db, tenantId, declared.user.id);
    expect(profile.location).toMatchObject({ regionCode: 'US-TX', source: 'declared', confidence: 0.6 });
    await upsertUser(runtime.db, { tenantId, externalId: 'loc', location: { ip: '198.51.100.7' }, geo });
    profile = await loadProfile(runtime.db, tenantId, declared.user.id);
    expect(profile.location).toMatchObject({ regionCode: 'US-CA', source: 'ip', confidence: 0.9 });
    // An address the provider cannot place leaves the last known location alone.
    await upsertUser(runtime.db, { tenantId, externalId: 'loc', location: { ip: '10.0.0.1' }, geo });
    profile = await loadProfile(runtime.db, tenantId, declared.user.id);
    expect(profile.location?.regionCode).toBe('US-CA');
    expect(await runtime.db.select().from(userLocations)).toHaveLength(1);
    // Without a provider a location cannot be taken.
    const noGeo = await rejection(upsertUser(runtime.db, { tenantId, externalId: 'loc', location: { declaredRegion: 'US-TX' } }));
    expect(isUsersError(noGeo, 'invalid_input')).toBe(true);
  });

  it('restrictions: a user may exclude themself and cool off, never lift them, and only the active ones count', async () => {
    const user = await createUser(runtime.db, tenantId);
    const me = { kind: 'user' as const, ref: user.id };
    const exclusion = await addRestriction(runtime.db, { tenantId, userId: user.id, kind: 'self_exclusion', actor: me, reason: 'a month off', endsAt: new Date(Date.now() + 30 * 86_400_000) });
    expect(exclusion).toMatchObject({ kind: 'self_exclusion', createdBy: `user:${user.id}`, liftedAt: null, liftedBy: null });
    const cooling = await addRestriction(runtime.db, { tenantId, userId: user.id, kind: 'cool_off', actor: me, endsAt: new Date(Date.now() + 3_600_000) });
    const future = await addRestriction(runtime.db, { tenantId, userId: user.id, kind: 'platform_block', actor: { kind: 'operator', ref: 'op_1' }, startsAt: new Date(Date.now() + 86_400_000) });
    expect((await activeRestrictions(runtime.db, user.id)).map((row) => row.id)).toEqual([exclusion.id, cooling.id]);
    expect((await activeRestrictions(runtime.db, user.id, new Date(Date.now() + 2 * 86_400_000))).map((row) => row.id)).toEqual([exclusion.id, future.id]);

    // The user cannot lift, cannot block, and cannot cool off without an end.
    expect(isUsersError(await rejection(liftRestriction(runtime.db, { tenantId, restrictionId: exclusion.id, actor: me })), 'restriction_lift_forbidden')).toBe(true);
    expect(isUsersError(await rejection(addRestriction(runtime.db, { tenantId, userId: user.id, kind: 'platform_block', actor: me })), 'restriction_lift_forbidden')).toBe(true);
    expect(isUsersError(await rejection(addRestriction(runtime.db, { tenantId, userId: user.id, kind: 'cool_off', actor: me })), 'invalid_input')).toBe(true);
    expect(isUsersError(await rejection(addRestriction(runtime.db, { tenantId, userId: user.id, kind: 'cool_off', actor: me, endsAt: new Date(Date.now() - 1) })), 'invalid_input')).toBe(true);

    // An operator lifts once; the lift is recorded and cannot be undone or repeated.
    const lifted = await liftRestriction(runtime.db, { tenantId, restrictionId: cooling.id, actor: { kind: 'operator', ref: 'op_1' } });
    expect(lifted).toMatchObject({ id: cooling.id, liftedBy: 'operator:op_1' });
    expect(lifted.liftedAt).toBeInstanceOf(Date);
    expect((await activeRestrictions(runtime.db, user.id)).map((row) => row.id)).toEqual([exclusion.id]);
    expect(isUsersError(await rejection(liftRestriction(runtime.db, { tenantId, restrictionId: cooling.id, actor: { kind: 'operator', ref: 'op_2' } })), 'restriction_already_lifted')).toBe(true);
    const unlift = await rejection(migrator.sql`update user_restrictions set lifted_at = null, lifted_by = null where id = ${cooling.id}`);
    expect(String(unlift)).toMatch(/already lifted/);
    const shorten = await rejection(migrator.sql`update user_restrictions set ends_at = now() where id = ${exclusion.id}`);
    expect(String(shorten)).toMatch(/fixed once written/);
    const runtimeShorten = await rejection(runtime.sql`update user_restrictions set ends_at = now() where id = ${exclusion.id}`);
    expect(String(runtimeShorten)).toMatch(/permission denied for table user_restrictions/);
    const other = await createTenant(runtime.db);
    expect(isUsersError(await rejection(liftRestriction(runtime.db, { tenantId: other, restrictionId: exclusion.id, actor: { kind: 'operator' } })), 'user_wrong_tenant')).toBe(true);
  });
});

describe('verification state machine', () => {
  let migrator: Database;
  let runtime: Database;
  let tenantId: Id<'tnt'>;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  beforeEach(async () => {
    await wipeLedger(migrator);
    tenantId = await createTenant(runtime.db);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  const identity = devIdentityProvider({ deny: ['denied'], pending: ['slow'] });

  it('unstarted -> pending -> verified, recording the provider reference and instant, and minting a single-use embed token', async () => {
    const { user } = await upsertUser(runtime.db, { tenantId, externalId: 'ok', displayName: 'Ana Reyes', dateOfBirth: '1994-03-12' });
    const now = new Date('2026-09-18T12:00:00.000Z');
    const started = await startVerification(runtime.db, { tenantId, userId: user.id, identity, actor: { kind: 'tenant', ref: 'key_1' }, requestId: 'req-v', now });
    expect(started.before.state).toBe('unstarted');
    expect(started.result.outcome).toBe('verified');
    expect(started.verification).toMatchObject({ state: 'verified', provider: 'dev', verifiedAt: now, reverifyAfter: new Date('2027-09-18T12:00:00.000Z') });
    expect(started.verification.providerRef).toMatch(/^dev-[0-9a-f]{24}$/);
    expect(started.embedToken.token).toMatch(/^embt_[A-Za-z0-9_-]{43}$/);
    expect(started.embedToken.row).toMatchObject({ userId: user.id, flow: 'identity', consumedAt: null, expiresAt: new Date('2026-09-18T12:05:00.000Z') });

    const audit = await runtime.db.select().from(auditLog).where(eq(auditLog.subject, user.id));
    expect(audit.map((row) => [row.action, row.actorKind, row.actorRef])).toEqual([
      ['user.created', 'system', null],
      ['user.verification.started', 'tenant', 'key_1'],
      ['user.verification.verified', 'system', 'provider:dev'],
    ]);
    expect(audit[2]?.after).toMatchObject({ state: 'verified', note: 'demographics supplied' });

    // Verified and not due: nothing to do. Due: it can be started again.
    expect(isUsersError(await rejection(startVerification(runtime.db, { tenantId, userId: user.id, identity, now })), 'already_verified')).toBe(true);
    const due = new Date('2027-09-18T12:00:00.000Z');
    const again = await startVerification(runtime.db, { tenantId, userId: user.id, identity, now: due });
    expect(again.before.state).toBe('verified');
    expect(again.verification).toMatchObject({ state: 'verified', verifiedAt: due });
    expect((await runtime.db.select().from(auditLog).where(eq(auditLog.subject, user.id))).map((row) => row.action)).toContain('user.verification.restarted');

    // The embed token opens the identity flow exactly once.
    const consumed = await consumeEmbedToken(runtime.db, { token: started.embedToken.token, flow: 'identity', now });
    expect(consumed.consumedAt).toBeInstanceOf(Date);
    expect((await rejection(consumeEmbedToken(runtime.db, { token: started.embedToken.token, now }))) as { code: string }).toMatchObject({ code: 'embed_token_used' });
  });

  it('a rejection is terminal for the user and pending can be resumed', async () => {
    const denied = await upsertUser(runtime.db, { tenantId, externalId: 'denied', displayName: 'X', dateOfBirth: '1990-01-01' });
    const rejected = await startVerification(runtime.db, { tenantId, userId: denied.user.id, identity });
    expect(rejected.verification).toMatchObject({ state: 'rejected', verifiedAt: null, reverifyAfter: null });
    expect(rejected.verification.providerRef).toMatch(/^dev-/);
    expect(isUsersError(await rejection(startVerification(runtime.db, { tenantId, userId: denied.user.id, identity })), 'verification_rejected')).toBe(true);

    const slow = await upsertUser(runtime.db, { tenantId, externalId: 'slow', displayName: 'Y', dateOfBirth: '1990-01-01' });
    const pending = await startVerification(runtime.db, { tenantId, userId: slow.user.id, identity });
    expect(pending.verification.state).toBe('pending');
    const resumed = await startVerification(runtime.db, { tenantId, userId: slow.user.id, identity });
    expect(resumed.before.state).toBe('pending');
    expect(resumed.verification.state).toBe('pending');
    expect(resumed.embedToken.token).not.toBe(pending.embedToken.token);

    // Without demographics the dev provider cannot verify.
    const bare = await upsertUser(runtime.db, { tenantId, externalId: 'bare' });
    expect((await startVerification(runtime.db, { tenantId, userId: bare.user.id, identity })).verification.state).toBe('rejected');
  });

  it('applies a provider answer only while still pending, and reports a provider failure without moving', async () => {
    const { user } = await upsertUser(runtime.db, { tenantId, externalId: 'race', displayName: 'Z', dateOfBirth: '1990-01-01' });
    // A provider whose answer arrives after an operator already resolved the row.
    const late: IdentityProvider = {
      name: 'dev',
      verify: async () => {
        await migrator.db.update(userVerification).set({ state: 'rejected', providerRef: 'op-reset' }).where(eq(userVerification.userId, user.id));
        return { outcome: 'verified', providerRef: 'late' };
      },
    };
    const result = await startVerification(runtime.db, { tenantId, userId: user.id, identity: late });
    expect(result.verification).toMatchObject({ state: 'rejected', providerRef: 'op-reset' });

    const { user: other } = await upsertUser(runtime.db, { tenantId, externalId: 'down', displayName: 'W', dateOfBirth: '1990-01-01' });
    const broken: IdentityProvider = { name: 'dev', verify: () => Promise.reject(new Error('vendor timeout')) };
    const failure = await rejection(startVerification(runtime.db, { tenantId, userId: other.id, identity: broken }));
    expect(isUsersError(failure, 'provider_unavailable')).toBe(true);
    const [row] = await runtime.db.select().from(userVerification).where(eq(userVerification.userId, other.id));
    expect(row?.state).toBe('pending');
  });

  it('the database holds the graph and admits nothing that could be a document', async () => {
    const user = await createUser(runtime.db, tenantId);
    const set = (patch: string) => rejection(migrator.sql.unsafe(`update user_verification set ${patch} where user_id = '${user.id}'`));
    expect(String(await set(`state = 'verified', verified_at = now(), provider = 'dev'`))).toMatch(/cannot move from unstarted to verified/);
    expect(String(await set(`state = 'rejected', provider = 'dev'`))).toMatch(/cannot move from unstarted to rejected/);
    await migrator.sql`update user_verification set state = 'pending', provider = 'dev' where user_id = ${user.id}`;
    expect(String(await set(`state = 'unstarted', provider = null`))).toMatch(/cannot move from pending to unstarted/);
    // Never a document: a URL, a data URI, a JSON blob or anything long is refused as a reference.
    for (const value of ['https://vendor.example/inquiry/123', 'data:image/png;base64,iVBORw0KGgo=', '{"document":"passport"}', 'x'.repeat(129), 'has space']) {
      expect(String(await set(`provider_ref = '${value}'`)), value).toMatch(/user_verification_provider_ref_opaque/);
    }
    expect(String(await set(`state = 'verified', provider_ref = 'inq_123'`))).toMatch(/user_verification_verified_at_iff_verified/);
    const columns = await runtime.sql<Array<{ column: string }>>`select column_name as "column" from information_schema.columns where table_name = 'user_verification' order by 1`;
    expect(columns.map((row) => row.column)).toEqual(['provider', 'provider_ref', 'reverify_after', 'state', 'updated_at', 'user_id', 'verified_at']);
  });
});
