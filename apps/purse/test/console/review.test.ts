import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ConsoleRestrictionResource, ConsoleUserResource, OperatorFlagResource, UserSummaryResource } from '@purse/types';

import { auditLog, operatorFlags, users } from '../../src/db/schema';
import { refreshFingerprint } from '../../src/users';
import { buildArena, eligibleUser } from '../contests/fixtures';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { createTenant, createUser, key, wipeLedger } from '../ledger/fixtures';
import { consoleClient } from './client';

/**
 * The review queues and restrictions (spec 4.6, 4.10): duplicate-identity flags listed
 * with the users they name, resolved or dismissed once with an audit row; a tenant's
 * users found by id, external id, name or phone; one user with every restriction, wallet
 * and open flag; restrictions placed by the operator with a reason and lifted.
 */
describe('console review queues and restrictions', () => {
  let h: TestHarness;
  let owner: ReturnType<typeof connectMigrator>;

  beforeAll(() => {
    owner = connectMigrator();
    h = harness();
  });
  beforeEach(async () => {
    await wipeLedger(owner);
  });
  afterAll(async () => {
    await wipeLedger(owner);
    await h.close();
    await owner.close();
  });

  it('lists duplicate-identity flags with both users, and resolves or dismisses each once', async () => {
    const tenantId = await createTenant(h.database.db);
    const a = await createUser(h.database.db, tenantId, { displayName: 'Sam Okafor', dateOfBirth: '1996-09-09', externalId: 'sam-1' });
    const b = await createUser(h.database.db, tenantId, { displayName: 'Sam Okafor', dateOfBirth: '1996-09-09', externalId: 'sam-2' });
    await h.database.db.transaction((tx) => refreshFingerprint(tx, a));
    await h.database.db.transaction((tx) => refreshFingerprint(tx, b));
    const { api, session } = await consoleClient(h, owner.db, 'operator');

    const open = await api.get<{ flags: OperatorFlagResource[] }>('/console/flags?status=open&kind=duplicate_identity');
    expect(open.status).toBe(200);
    expect(open.data?.flags).toHaveLength(1);
    const flag = open.data?.flags[0];
    expect(flag).toMatchObject({ kind: 'duplicate_identity', status: 'open', tenantId });
    expect(flag?.users.map((each) => each.externalId).sort()).toEqual(['sam-1', 'sam-2']);

    const reviewed = await api.post<OperatorFlagResource>(`/console/tenants/${tenantId}/flags/${flag?.id}/review`, { status: 'reviewed', note: 'same person, blocked the second account' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.data).toMatchObject({ status: 'reviewed', reviewedBy: `operator:${session.operator.id}` });
    expect(reviewed.data?.reviewedAt).not.toBeNull();
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.action, 'operator_flag.reviewed'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'operator', actorRef: session.operator.id, subject: flag?.id, after: { status: 'reviewed', note: 'same person, blocked the second account' } });

    // Reviewing again with the same outcome is a no-op; a different outcome is refused.
    const again = await api.post<OperatorFlagResource>(`/console/tenants/${tenantId}/flags/${flag?.id}/review`, { status: 'reviewed' });
    expect(again.status).toBe(200);
    const flip = await api.post(`/console/tenants/${tenantId}/flags/${flag?.id}/review`, { status: 'dismissed' });
    expect(flip.status).toBe(409);
    expect(flip.error?.code).toBe('flag_already_reviewed');
    expect((await api.get<{ flags: OperatorFlagResource[] }>('/console/flags?status=open')).data?.flags).toEqual([]);
    expect(await owner.db.select().from(operatorFlags)).toHaveLength(1);
    // A flag of another tenant is not reachable through this one.
    const other = await createTenant(h.database.db);
    expect((await api.post(`/console/tenants/${other}/flags/${flag?.id}/review`, { status: 'dismissed' })).status).toBe(400);
  });

  it('finds users by id, external id, name or phone and shows one with wallets, restrictions and flags', async () => {
    const arena = await buildArena(h.database.db, { users: 2, funding: 500n });
    const [first, second] = arena.users;
    await h.database.db.update(users).set({ displayName: 'Ana Reyes', phoneE164: '+15125550101' }).where(eq(users.id, first ?? ''));
    const { api } = await consoleClient(h, owner.db, 'operator');
    const base = `/console/tenants/${arena.tenantId}`;
    const all = await api.get<{ users: UserSummaryResource[] }>(`${base}/users`);
    expect(all.data?.users.map((each) => each.id).sort()).toEqual([first, second].sort());
    expect((await api.get<{ users: UserSummaryResource[] }>(`${base}/users?q=ana`)).data?.users.map((each) => each.id)).toEqual([first]);
    expect((await api.get<{ users: UserSummaryResource[] }>(`${base}/users?q=%2B15125550101`)).data?.users.map((each) => each.id)).toEqual([first]);
    expect((await api.get<{ users: UserSummaryResource[] }>(`${base}/users?q=${second}`)).data?.users.map((each) => each.id)).toEqual([second]);
    expect((await api.get<{ users: UserSummaryResource[] }>(`${base}/users?q=nobody-here`)).data?.users).toEqual([]);

    const detail = await api.get<ConsoleUserResource>(`${base}/users/${first}`);
    expect(detail.status).toBe(200);
    expect(detail.data?.user).toMatchObject({ id: first, displayName: 'Ana Reyes', verification: { state: 'verified' } });
    expect(detail.data?.wallets.find((each) => each.asset === 'POINTS')).toMatchObject({ balance: '500' });
    expect(detail.data?.wallets.find((each) => each.asset === 'CREDIT')).toMatchObject({ balance: '0', accountId: null });
    expect(detail.data?.restrictions).toEqual([]);
    expect(detail.data?.openFlags).toEqual([]);
    const other = await createTenant(h.database.db);
    expect((await api.get(`/console/tenants/${other}/users/${first}`)).status).toBe(403);
  });

  it('places an operator restriction with a reason, shows it on the user with the reason, and lifts it', async () => {
    const tenantId = await createTenant(h.database.db);
    const userId = await eligibleUser(h.database.db, tenantId);
    const { api, session } = await consoleClient(h, owner.db, 'operator');
    const base = `/console/tenants/${tenantId}`;

    const noReason = await api.post(`${base}/users/${userId}/restrictions`, { kind: 'platform_block' });
    expect(noReason.status).toBe(400);
    const temporaryWithoutEnd = await api.post(`${base}/users/${userId}/restrictions`, { kind: 'cool_off', reason: 'asked for a break' });
    expect(temporaryWithoutEnd.status).toBe(400);
    expect(temporaryWithoutEnd.error?.code).toBe('invalid_input');
    const userKind = await api.post(`${base}/users/${userId}/restrictions`, { kind: 'self_exclusion', reason: 'x' });
    expect(userKind.status).toBe(400);

    const idempotencyKey = key('console-restrict');
    const placed = await api.post<ConsoleRestrictionResource>(`${base}/users/${userId}/restrictions`, { kind: 'platform_block', reason: 'chargeback fraud' }, { idempotencyKey });
    expect(placed.status).toBe(201);
    expect(placed.data).toMatchObject({ kind: 'platform_block', reason: 'chargeback fraud', active: true, liftedAt: null, createdBy: `operator:${session.operator.id}` });
    const replay = await api.post<ConsoleRestrictionResource>(`${base}/users/${userId}/restrictions`, { kind: 'platform_block', reason: 'chargeback fraud' }, { idempotencyKey });
    expect(replay.data?.id).toBe(placed.data?.id);
    const ends = new Date(Date.now() + 3_600_000).toISOString();
    const lock = await api.post<ConsoleRestrictionResource>(`${base}/users/${userId}/restrictions`, { kind: 'velocity_lock', reason: 'ten entries in an hour', endsAt: ends });
    expect(lock.status).toBe(201);

    const detail = await api.get<ConsoleUserResource>(`${base}/users/${userId}`);
    expect(detail.data?.restrictions.map((each) => [each.kind, each.reason, each.active])).toEqual([
      ['velocity_lock', 'ten entries in an hour', true],
      ['platform_block', 'chargeback fraud', true],
    ]);
    // The v1 resource (what a partner sees) carries no operator reason.
    expect(detail.data?.user.restrictions.map((each) => each.reason)).toEqual([undefined, undefined]);

    const lifted = await api.post<ConsoleRestrictionResource>(`${base}/restrictions/${placed.data?.id}/lift`, {});
    expect(lifted.status).toBe(200);
    expect(lifted.data).toMatchObject({ active: false, liftedBy: `operator:${session.operator.id}` });
    const twice = await api.post(`${base}/restrictions/${placed.data?.id}/lift`, {});
    expect(twice.status).toBe(409);
    const audit = await owner.db.select().from(auditLog).where(eq(auditLog.subject, placed.data?.id ?? '')).orderBy(auditLog.createdAt, auditLog.id);
    expect(audit.map((row) => row.action)).toEqual(['user.restriction.added', 'user.restriction.lifted']);
    expect(audit.every((row) => row.actorKind === 'operator' && row.actorRef === session.operator.id)).toBe(true);
  });
});
