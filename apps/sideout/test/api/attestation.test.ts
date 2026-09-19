import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, ES256_KEY, exportPublicJwk, generateAttestationKeyPair, jwkThumbprint, signAttestation, verifyAttestation, type CanonicalValue, type EcPublicJwk } from '@purse/types';

import { GET as listDisputes } from '../../src/app/api/admin/disputes/route';
import { POST as revokeDevice } from '../../src/app/api/admin/devices/[id]/revoke/route';
import { POST as draw } from '../../src/app/api/admin/tournaments/[id]/draw/route';
import { PATCH as patchTournament } from '../../src/app/api/admin/tournaments/[id]/route';
import { POST as createTournament } from '../../src/app/api/admin/tournaments/route';
import { POST as submitScores } from '../../src/app/api/matches/[id]/scores/route';
import { GET as getMatch } from '../../src/app/api/matches/[id]/route';
import { POST as linkPurse } from '../../src/app/api/me/purse/link/route';
import { GET as listDevices, POST as checkIn } from '../../src/app/api/teams/[id]/devices/route';
import { POST as readBackEntries } from '../../src/app/api/teams/[id]/purse/entries/route';
import { auditLog, matches, scoreSubmissions, teamDevices, teamMembers, tournaments, users, type Charity, type User } from '../../src/db/schema';
import { attestationPayload, DEVICE_AUDIT, type DeviceView } from '../../src/domain/attestation';
import { canonicalizeScoreline } from '../../src/domain/scoreline-hash';
import { databaseCallRecorder, PurseClient } from '../../src/purse';
import type { ConsensusView, DisputeView } from '../../src/server/consensus';
import { appContext, resetAppContext } from '../../src/server/context';
import type { DrawOutcome } from '../../src/server/draw';
import { ATTESTATION_VECTORS as vectors } from '../attestation/vectors';
import { cookieFor, createCharity, createUser, data, errorOf, params, request, testDatabase, truncateAll, type Database } from '../helpers';
import { FakePurse } from '../purse/fake-purse';
import { registerTeams, tournamentBody } from './fixtures';

/**
 * Signed score attestation end to end on Sideout's side (spec section 12, item 1;
 * docs/attestation.md): a phone checks in for its team, the key is mirrored to Purse, a
 * scoreline it signs is verified against the registered key before the consensus sees it
 * and stored on the submission, a signature that fails any check is refused with
 * `invalid_attestation` (422) and nothing is stored, the organizer's revocation is honoured
 * for a queued scoreline, and both teams' verified attestations travel with the agreed
 * scores to Purse, which records them `verified`.
 */
type MatchResponse = { match: { id: string; status: string; teamAId: string | null; teamBId: string | null }; consensus: ConsensusView | null };
type SubmitResponse = { outcome: string; consensus: ConsensusView; purse: { status: string } | null };
type BracketMatch = { id: string; round: number; teamAId: string | null; teamBId: string | null; status: string };
type CheckInResponse = { device: DeviceView; created: boolean; mirror: { status: string; reason?: string }; devices: DeviceView[] };
type SetInput = { setNumber: number; usPoints: number; themPoints: number };

/** A phone: a fresh non-extractable key pair, the way the browser makes one. */
async function phone() {
  const pair = await generateAttestationKeyPair();
  const publicKey = await exportPublicJwk(pair.publicKey);
  return { pair, publicKey, keyId: await jwkThumbprint(publicKey) };
}

/** Match-oriented sets from a submitter's own reading. */
function oriented(sets: readonly SetInput[], side: 'a' | 'b') {
  return sets.map((s) => ({ setNumber: s.setNumber, teamAPoints: side === 'a' ? s.usPoints : s.themPoints, teamBPoints: side === 'a' ? s.themPoints : s.usPoints }));
}

describe('signed score attestation', () => {
  let database: Database;
  let organizer: User;
  let charity: Charity;
  let fake: FakePurse;

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    fake = new FakePurse();
    resetAppContext({ purse: new PurseClient({ baseUrl: 'http://purse.test', secretKey: fake.secretKey, recorder: databaseCallRecorder(database.db), fetch: fake.fetch }) });
    organizer = await createUser(database, { role: 'organizer' });
    charity = await createCharity(database);
  });
  afterAll(async () => {
    await database.close();
  });

  const organizerCookie = () => cookieFor(organizer);
  const patch = (id: string, body: Record<string, unknown>) => patchTournament(request('PATCH', '/x', { body, cookie: organizerCookie() }), params({ id }));

  /** A live single-elimination event of four teams, every player linked and entered in the fake Purse. */
  async function liveBracket(): Promise<{ id: string; teamIds: string[]; bracket: BracketMatch[]; captains: Map<string, User>; players: Map<string, User> }> {
    const { tournament } = await data<{ tournament: { id: string; slug: string } }>(
      await createTournament(request('POST', '/x', { body: tournamentBody(charity, { format: 'single_elim', maxTeams: 4, entryDonationCents: '0' }), cookie: organizerCookie() })),
    );
    await data(await patch(tournament.id, { status: 'registration_open' }));
    const teamIds = await registerTeams(database, tournament.id, 4, { 0: 1, 1: 2, 2: 3, 3: 4 });
    const captains = new Map<string, User>();
    const players = new Map<string, User>();
    for (const teamId of teamIds) {
      const members = await database.db.select({ member: teamMembers, user: users }).from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId)).where(eq(teamMembers.teamId, teamId));
      for (const { member, user } of members) {
        (member.role === 'captain' ? captains : players).set(teamId, user);
        await data(await linkPurse(request('POST', '/x', { cookie: cookieFor(user) })));
      }
    }
    await data(await patch(tournament.id, { status: 'registration_closed' }));
    const contest = fake.contestByExternalId((await database.db.select().from(tournaments).where(eq(tournaments.id, tournament.id)))[0]?.purseExternalId ?? '');
    if (contest === undefined) throw new Error('the contest was not created in Purse');
    const client = appContext().purse;
    if (client === null) throw new Error('no purse client');
    for (const user of [...captains.values(), ...players.values()]) {
      const fresh = (await database.db.select().from(users).where(eq(users.id, user.id)))[0];
      if (fresh?.purseUserId === null || fresh?.purseUserId === undefined) throw new Error('user not linked');
      await client.enterContest(contest.id, { userId: fresh.purseUserId }, { requestId: 'test', idempotencyKey: `entry:${user.id}` });
    }
    for (const teamId of teamIds) {
      const captain = captains.get(teamId);
      if (captain === undefined) throw new Error('no captain');
      await data(await readBackEntries(request('POST', '/x', { cookie: cookieFor(captain) }), params({ id: teamId })));
    }
    await data<DrawOutcome>(await draw(request('POST', '/x', { body: { stage: 'bracket', courts: 2, rngSeed: 3 }, cookie: organizerCookie() }), params({ id: tournament.id })));
    await data(await patch(tournament.id, { status: 'live' }));
    const rows = await database.db.select().from(matches).where(eq(matches.tournamentId, tournament.id)).orderBy(asc(matches.bracketPosition));
    return { id: tournament.id, teamIds, bracket: rows.map((m) => ({ id: m.id, round: m.round, teamAId: m.teamAId, teamBId: m.teamBId, status: m.status })), captains, players };
  }

  function firstMatch(t: Awaited<ReturnType<typeof liveBracket>>) {
    const match = t.bracket.find((m) => m.round === 1);
    if (match?.teamAId === null || match?.teamAId === undefined || match.teamBId === null) throw new Error('no round-one match with both teams');
    const captainA = t.captains.get(match.teamAId);
    const captainB = t.captains.get(match.teamBId);
    if (captainA === undefined || captainB === undefined) throw new Error('no captain');
    return { match, teamAId: match.teamAId, teamBId: match.teamBId, captainA, captainB };
  }

  const WIN: SetInput[] = [
    { setNumber: 1, usPoints: 21, themPoints: 18 },
    { setNumber: 2, usPoints: 21, themPoints: 15 },
  ];
  const LOSS: SetInput[] = [
    { setNumber: 1, usPoints: 18, themPoints: 21 },
    { setNumber: 2, usPoints: 15, themPoints: 21 },
  ];

  const check = (teamId: string, user: User, publicKey: unknown) => checkIn(request('POST', '/x', { body: { publicKey }, cookie: cookieFor(user) }), params({ id: teamId }));

  /** Sign a reading the way the phone does: over the canonical, match-oriented sets bound to the tournament, match and team. */
  async function signed(input: { pair: CryptoKeyPair; keyId: string }, binding: { tournamentId: string; matchId: string; teamId: string; side: 'a' | 'b' }, sets: SetInput[], timestamp = new Date().toISOString()) {
    const payload = attestationPayload({ keyId: input.keyId, timestamp, tournamentId: binding.tournamentId, matchId: binding.matchId, teamId: binding.teamId, sets: oriented(sets, binding.side) });
    return { keyId: input.keyId, algorithm: 'ES256' as const, signature: await signAttestation(input.pair.privateKey, payload), timestamp };
  }

  const submit = (matchId: string, user: User, sets: SetInput[], attestation?: unknown) => submitScores(request('POST', '/x', { body: attestation === undefined ? { sets } : { sets, attestation }, cookie: cookieFor(user) }), params({ id: matchId }));

  it('checks a phone in for the member’s team, once, mirrors the key to Purse, and lists it', async () => {
    const t = await liveBracket();
    const { teamAId, teamBId, captainA, captainB } = firstMatch(t);
    const device = await phone();
    const first = await checkIn(request('POST', '/x', { body: { publicKey: device.publicKey }, cookie: cookieFor(captainA) }), params({ id: teamAId }));
    expect(first.status).toBe(201);
    const created = await data<CheckInResponse>(first);
    expect(created.created).toBe(true);
    expect(created.device).toMatchObject({ teamId: teamAId, userId: captainA.id, keyId: device.keyId, algorithm: 'ES256', publicKey: device.publicKey, revokedAt: null, mirrored: true });
    expect(created.mirror.status).toBe('mirrored');
    const captainPurseId = (await database.db.select().from(users).where(eq(users.id, captainA.id)))[0]?.purseUserId;
    expect(fake.devices.map((d) => [d.userId, d.keyId])).toEqual([[captainPurseId, device.keyId]]);
    expect(fake.requests.find((r) => r.path.endsWith('/devices'))?.body).toEqual({ publicKey: device.publicKey, label: `sideout:${teamAId}` });

    // Again from the same phone: the same row, no second mirror.
    const again = await check(teamAId, captainA, device.publicKey);
    expect(again.status).toBe(200);
    expect((await data<CheckInResponse>(again)).device.id).toBe(created.device.id);
    expect(fake.devices).toHaveLength(1);

    // Not a member of that team, a private key, an RSA key: refused, nothing stored.
    expect(await errorOf(await check(teamAId, captainB, device.publicKey))).toMatchObject({ type: 'permission_error', code: 'not_on_team' });
    expect(await errorOf(await check(teamAId, captainA, vectors.privateJwk))).toMatchObject({ type: 'invalid_request', code: 'invalid_public_key' });
    expect(await errorOf(await check(teamAId, captainA, { kty: 'RSA', n: 'x', e: 'AQAB' }))).toMatchObject({ type: 'invalid_request', code: 'invalid_public_key' });
    expect(await database.db.select().from(teamDevices)).toHaveLength(1);

    // Listing: a member or the organizer; a stranger is refused.
    const listed = await data<{ devices: DeviceView[] }>(await listDevices(request('GET', '/x', { cookie: cookieFor(captainA) }), params({ id: teamAId })));
    expect(listed.devices.map((d) => d.id)).toEqual([created.device.id]);
    expect((await data<{ devices: DeviceView[] }>(await listDevices(request('GET', '/x', { cookie: organizerCookie() }), params({ id: teamAId })))).devices).toHaveLength(1);
    expect(await errorOf(await listDevices(request('GET', '/x', { cookie: cookieFor(captainB) }), params({ id: teamAId })))).toMatchObject({ code: 'not_on_team' });
    expect((await data<{ devices: DeviceView[] }>(await listDevices(request('GET', '/x', { cookie: cookieFor(captainB) }), params({ id: teamBId })))).devices).toEqual([]);

    const audits = await database.db.select().from(auditLog).where(eq(auditLog.action, DEVICE_AUDIT.registered));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ deviceId: created.device.id, keyId: device.keyId });
    expect(JSON.stringify(audits)).not.toContain('"d":');
  });

  it('a phone checked in before the Purse link is mirrored when the player links', async () => {
    const { tournament } = await data<{ tournament: { id: string } }>(await createTournament(request('POST', '/x', { body: tournamentBody(charity, { format: 'single_elim', maxTeams: 4, entryDonationCents: '0' }), cookie: organizerCookie() })));
    await data(await patch(tournament.id, { status: 'registration_open' }));
    const [teamId] = await registerTeams(database, tournament.id, 1);
    const [member] = await database.db.select({ user: users }).from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId)).where(eq(teamMembers.teamId, teamId ?? ''));
    if (member === undefined || teamId === undefined) throw new Error('no member');
    const device = await phone();
    const created = await data<CheckInResponse>(await check(teamId, member.user, device.publicKey));
    expect(created.mirror.status).toBe('skipped');
    expect(created.device.mirrored).toBe(false);
    expect(fake.devices).toHaveLength(0);
    await data(await linkPurse(request('POST', '/x', { cookie: cookieFor(member.user) })));
    expect(fake.devices.map((d) => d.keyId)).toEqual([device.keyId]);
    const [row] = await database.db.select().from(teamDevices).where(eq(teamDevices.id, created.device.id));
    expect(row?.purseDeviceId).toBe(fake.devices[0]?.id);
  });

  it('verifies a signed scoreline against the checked-in key, stores it on the submission, and shows it on the match', async () => {
    const t = await liveBracket();
    const { match, teamAId, captainA } = firstMatch(t);
    const device = await phone();
    await data(await check(teamAId, captainA, device.publicKey));
    const attestation = await signed(device, { tournamentId: t.id, matchId: match.id, teamId: teamAId, side: 'a' }, WIN);
    const result = await data<SubmitResponse>(await submit(match.id, captainA, WIN, attestation));
    expect(result.outcome).toBe('awaiting_second');
    const mine = result.consensus.live.find((s) => s.teamId === teamAId);
    expect(mine?.attestation).toMatchObject({ keyId: device.keyId, userId: captainA.id, timestamp: attestation.timestamp });
    expect(mine?.attestation?.deviceId).toMatch(/^dev_/);

    const [row] = await database.db.select().from(scoreSubmissions).where(eq(scoreSubmissions.matchId, match.id));
    expect(row?.attestation).toMatchObject({ keyId: device.keyId, signature: attestation.signature, refs: { tournamentId: t.id, teamId: teamAId }, content: { matchId: match.id, sets: [[1, 21, 18], [2, 21, 15]] } });
    // The stored content is the very bytes the consensus hashes.
    expect(canonicalJson((row?.attestation?.content ?? null) as CanonicalValue)).toBe(canonicalizeScoreline({ matchId: match.id, sets: oriented(WIN, 'a') }));
    expect(await verifyAttestation(device.publicKey, attestationPayload({ keyId: device.keyId, timestamp: attestation.timestamp, tournamentId: t.id, matchId: match.id, teamId: teamAId, sets: oriented(WIN, 'a') }), attestation.signature)).toBe(true);
    const audit = (await database.db.select().from(auditLog).where(eq(auditLog.action, 'score.submitted')))[0];
    expect(audit?.detail).toMatchObject({ attested: true, keyId: device.keyId });

    // The public match view carries the badge's facts and nothing private.
    const view = await data<MatchResponse>(await getMatch(request('GET', '/x'), params({ id: match.id })));
    expect(view.consensus?.live[0]?.attestation).toMatchObject({ keyId: device.keyId });
    expect(JSON.stringify(view)).not.toMatch(/signature|publicKey|"x":|"y":/);
  });

  it('refuses a signature that fails any check with invalid_attestation (422) and stores nothing', async () => {
    const t = await liveBracket();
    const { match, teamAId, teamBId, captainA, captainB } = firstMatch(t);
    const device = await phone();
    const stranger = await phone();
    await data(await check(teamAId, captainA, device.publicKey));
    await data(await check(teamBId, captainB, stranger.publicKey));
    const binding = { tournamentId: t.id, matchId: match.id, teamId: teamAId, side: 'a' as const };
    const other = t.bracket.find((m) => m.round === 1 && m.id !== match.id);
    if (other === undefined) throw new Error('no other match');
    const OTHER_WIN: SetInput[] = [
      { setNumber: 1, usPoints: 21, themPoints: 17 },
      { setNumber: 2, usPoints: 21, themPoints: 15 },
    ];
    const cases: Array<[string, unknown]> = [
      // A key the team never checked in (the other team's phone).
      ['unknown_device', await signed(stranger, binding, WIN)],
      // Signed by the right phone over a different scoreline.
      ['signature_invalid', await signed(device, binding, OTHER_WIN)],
      // Signed for another match.
      ['signature_invalid', await signed(device, { ...binding, matchId: other.id }, WIN)],
      // Signed as the other team.
      ['signature_invalid', await signed(device, { ...binding, teamId: teamBId }, WIN)],
      // Signed too long ago, and in the future.
      ['timestamp_expired', await signed(device, binding, WIN, new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString())],
      ['timestamp_future', await signed(device, binding, WIN, new Date(Date.now() + 10 * 60 * 1000).toISOString())],
      // The pinned vector's key, which no team here checked in.
      ['unknown_device', { keyId: vectors.keyId, algorithm: 'ES256', signature: vectors.signature, timestamp: new Date().toISOString() }],
    ];
    for (const [code, attestation] of cases) {
      const response = await submit(match.id, captainA, WIN, attestation);
      expect(response.status, code).toBe(422);
      expect(await errorOf(response), code).toMatchObject({ type: 'invalid_attestation', code });
    }
    // A malformed attestation is a plain validation error.
    expect(await errorOf(await submit(match.id, captainA, WIN, { keyId: 'short', algorithm: 'ES256', signature: 'x', timestamp: 'now' }))).toMatchObject({ type: 'invalid_request' });
    expect(await database.db.select().from(scoreSubmissions)).toHaveLength(0);
    const still = await data<MatchResponse>(await getMatch(request('GET', '/x'), params({ id: match.id })));
    expect(still.match.status).toBe('scheduled');
    expect(still.consensus).toBeNull();
    expect(fake.requests.filter((r) => r.path.endsWith('/scores'))).toHaveLength(0);
  });

  it('an unsigned submission is still accepted, and shown as unsigned', async () => {
    const t = await liveBracket();
    const { match, teamAId, captainA } = firstMatch(t);
    const result = await data<SubmitResponse>(await submit(match.id, captainA, WIN));
    expect(result.outcome).toBe('awaiting_second');
    expect(result.consensus.live.find((s) => s.teamId === teamAId)?.attestation).toBeNull();
  });

  it('the organizer’s revocation refuses a scoreline the phone signed before it, and reaches Purse', async () => {
    const t = await liveBracket();
    const { match, teamAId, captainA } = firstMatch(t);
    const device = await phone();
    const created = await data<CheckInResponse>(await check(teamAId, captainA, device.publicKey));
    // Signed while checked in, as a phone with no signal would, then queued.
    const queued = await signed(device, { tournamentId: t.id, matchId: match.id, teamId: teamAId, side: 'a' }, WIN);

    const revoked = await data<{ device: DeviceView; revoked: boolean; mirror: { status: string } }>(await revokeDevice(request('POST', '/x', { body: { reason: 'phone reported lost' }, cookie: organizerCookie() }), params({ id: created.device.id })));
    expect(revoked.revoked).toBe(true);
    expect(revoked.device.revokedAt).not.toBeNull();
    expect(revoked.mirror.status).toBe('mirrored');
    expect(fake.devices[0]?.revokedAt).not.toBeNull();
    expect(fake.devices[0]?.revokedReason).toBe('phone reported lost');
    expect(await errorOf(await revokeDevice(request('POST', '/x', { body: {}, cookie: cookieFor(captainA) }), params({ id: created.device.id })))).toMatchObject({ code: 'organizer_required' });

    // The replay after reconnect: refused and named, never silently dropped or accepted.
    const response = await submit(match.id, captainA, WIN, queued);
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({ type: 'invalid_attestation', code: 'device_revoked' });
    expect(await database.db.select().from(scoreSubmissions)).toHaveLength(0);

    // Checking the same phone in again is a new row; the old one stays revoked.
    const again = await data<CheckInResponse>(await check(teamAId, captainA, device.publicKey));
    expect(again.created).toBe(true);
    expect(again.device.id).not.toBe(created.device.id);
    expect(again.devices.map((d) => d.revokedAt === null)).toEqual([false, true]);
    expect(fake.devices).toHaveLength(2);
    const fresh = await signed(device, { tournamentId: t.id, matchId: match.id, teamId: teamAId, side: 'a' }, WIN);
    expect((await data<SubmitResponse>(await submit(match.id, captainA, WIN, fresh))).outcome).toBe('awaiting_second');
    const audits = await database.db.select().from(auditLog).where(eq(auditLog.action, DEVICE_AUDIT.revoked));
    expect(audits[0]?.detail).toMatchObject({ deviceId: created.device.id, reason: 'phone reported lost' });
  });

  it('both teams’ verified attestations travel with the agreed scores to Purse, which records them verified', async () => {
    const t = await liveBracket();
    const { match, teamAId, teamBId, captainA, captainB } = firstMatch(t);
    const phoneA = await phone();
    const phoneB = await phone();
    await data(await check(teamAId, captainA, phoneA.publicKey));
    await data(await check(teamBId, captainB, phoneB.publicKey));
    const first = await data<SubmitResponse>(await submit(match.id, captainA, WIN, await signed(phoneA, { tournamentId: t.id, matchId: match.id, teamId: teamAId, side: 'a' }, WIN)));
    expect(first.outcome).toBe('awaiting_second');
    const second = await data<SubmitResponse>(await submit(match.id, captainB, LOSS, await signed(phoneB, { tournamentId: t.id, matchId: match.id, teamId: teamBId, side: 'b' }, LOSS)));
    expect(second.outcome).toBe('agreed');
    expect(second.purse?.status).toBe('confirmed');

    const push = fake.requests.find((r) => r.path.endsWith('/scores') && !r.replayed);
    const batch = (push?.body as { scores: Array<{ userId: string; sourceRef: string; attestation: { userId: string; keyId: string; refs: Record<string, string>; content: unknown } | null }> }).scores;
    expect(batch).toHaveLength(4);
    const purseIdOf = async (user: User) => (await database.db.select().from(users).where(eq(users.id, user.id)))[0]?.purseUserId ?? '';
    const [aId, bId] = [await purseIdOf(captainA), await purseIdOf(captainB)];
    for (const score of batch) {
      expect(score.sourceRef).toBe(match.id);
      expect(score.attestation).not.toBeNull();
      const signer = score.attestation?.userId;
      expect([aId, bId]).toContain(signer);
      expect(score.attestation?.keyId).toBe(signer === aId ? phoneA.keyId : phoneB.keyId);
      expect(score.attestation?.refs).toEqual({ tournamentId: t.id, teamId: signer === aId ? teamAId : teamBId });
      expect(score.attestation?.content).toEqual({ matchId: match.id, sets: [[1, 21, 18], [2, 21, 15]] });
    }
    const contest = [...fake.contests.values()][0];
    expect(contest?.scores.filter((s) => !s.superseded).map((s) => s.attestationState)).toEqual(['verified', 'verified', 'verified', 'verified']);
    expect(contest?.scores.every((s) => s.attestation?.deviceId !== null)).toBe(true);
  });

  it('an unsigned reading sends no attestation, and a disputed pair shows which side signed in the organizer’s queue', async () => {
    const t = await liveBracket();
    const { match, teamAId, teamBId, captainA, captainB } = firstMatch(t);
    const phoneA = await phone();
    await data(await check(teamAId, captainA, phoneA.publicKey));
    await data(await submit(match.id, captainA, WIN, await signed(phoneA, { tournamentId: t.id, matchId: match.id, teamId: teamAId, side: 'a' }, WIN)));
    const OTHER: SetInput[] = [
      { setNumber: 1, usPoints: 21, themPoints: 18 },
      { setNumber: 2, usPoints: 21, themPoints: 15 },
    ];
    const disputed = await data<SubmitResponse>(await submit(match.id, captainB, OTHER));
    expect(disputed.outcome).toBe('disputed');
    const queue = await data<{ disputes: DisputeView[] }>(await listDisputes(request('GET', '/x', { cookie: organizerCookie() })));
    const entry = queue.disputes.find((d) => d.match.id === match.id);
    expect(entry?.consensus.live.map((s) => [s.teamId, s.attestation === null ? 'unsigned' : 'signed'])).toEqual([
      [teamAId, 'signed'],
      [teamBId, 'unsigned'],
    ]);
  });

  it('the pinned vectors verify here too, so the two apps agree on the canonical form', async () => {
    const publicJwk = vectors.publicJwk as EcPublicJwk;
    const payload = attestationPayload({
      keyId: vectors.keyId,
      timestamp: vectors.payload.timestamp,
      tournamentId: vectors.payload.refs.tournamentId,
      matchId: vectors.payload.sourceRef,
      teamId: vectors.payload.refs.teamId,
      sets: [
        { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
        { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
        { setNumber: 3, teamAPoints: 15, teamBPoints: 11 },
      ],
    });
    expect(payload).toEqual(vectors.payload);
    expect(await verifyAttestation(publicJwk, payload, vectors.signature)).toBe(true);
    expect(await jwkThumbprint(publicJwk)).toBe(vectors.keyId);
    const priv = await crypto.subtle.importKey('jwk', { ...vectors.privateJwk, ext: true }, ES256_KEY, false, ['sign']);
    expect(await verifyAttestation(publicJwk, payload, await signAttestation(priv, payload))).toBe(true);
  });
});
