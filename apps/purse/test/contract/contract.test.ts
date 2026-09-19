import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  API_ERROR_TYPES,
  ES256_KEY,
  signAttestation,
  type ApiErrorType,
  type AttestationPayload,
  type ContestResource,
  type DeviceResource,
  type EmbedTokenResource,
  type EmbedUserState,
  type EntryResource,
  type PreviewResource,
  type ResultsResource,
  type SettlementResource,
  type UserResource,
  type WebhookDeliveryResource,
  type WebhookEndpointResource,
} from '@purse/types';
import { type Id } from '@repo/ids';

import { resetAuthCaches } from '../../src/auth';
import type { Database } from '../../src/db/client';
import { eligibilityDecisions } from '../../src/db/schema';
import { reconcile } from '../../src/ledger';
import { addRestriction } from '../../src/users';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { bootstrapTenant, client, unknownUserId, type Bootstrap } from '../http/client';
import { key, wipeLedger } from '../ledger/fixtures';
import { ATTESTATION_VECTORS as vectors } from '../attestation/vectors';
import { Recorder, verifyFixtures } from './recorder';

/**
 * The contract (spec section 8): every v1 endpoint and every sealed error type, driven
 * over HTTP in one story, recorded as fixtures, and checked against the committed
 * `fixtures.json`. The story is the end-to-end flow: create users, issue credits, create
 * and open a contest, enter (eligible and not), lock, start, score, preview, close with the
 * hash, read the results, and reconcile clean. Every documented error type is reached and
 * carries a code no other type uses.
 */
describe('v1 contract', () => {
  let migrator: Database;
  let h: TestHarness;
  let boot: Bootstrap;
  beforeAll(async () => {
    migrator = connectMigrator();
    h = harness({ max: 6 });
    await wipeLedger(migrator);
    resetAuthCaches();
    boot = await bootstrapTenant(h.database.db);
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await h.close();
  });

  it('drives every endpoint and reaches every error type, matching the recorded fixtures', async () => {
    const op = new Recorder(client(h, boot.operatorKey));
    const plain = client(h, boot.plainKey);

    // ---- users ----------------------------------------------------------------------
    const ana = await op.record<UserResource>('users.create', 'POST', '/v1/users', { externalId: 'sideout:ana', displayName: 'Ana Reyes', dateOfBirth: '1994-03-12', phoneE164: '+15125550101', location: { declaredRegion: 'US-TX' } });
    expect(ana.status).toBe(201);
    expect(ana.data).toMatchObject({ externalId: 'sideout:ana', verification: { state: 'unstarted' }, location: { regionCode: 'US-TX', source: 'declared' }, restrictions: [] });
    const anaId = ana.data?.id ?? '';
    const upsert = await op.record<UserResource>('users.upsert', 'POST', '/v1/users', { externalId: 'sideout:ana', displayName: 'Ana M. Reyes' });
    expect(upsert.status).toBe(200);
    expect(upsert.data).toMatchObject({ id: anaId, displayName: 'Ana M. Reyes' });
    const invalid = await op.record('users.create.validation_failed', 'POST', '/v1/users', { externalId: '', dateOfBirth: 'yesterday' });
    expect(invalid.status).toBe(400);
    expect(invalid.error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });
    expect((invalid.error?.detail as { issues: unknown[] }).issues.length).toBeGreaterThanOrEqual(2);

    const marcus = (await op.record<UserResource>('users.create.second', 'POST', '/v1/users', { externalId: 'sideout:marcus', displayName: 'Marcus Lee', dateOfBirth: '1991-07-30' })).data;
    const priya = (await op.record<UserResource>('users.create.third', 'POST', '/v1/users', { externalId: 'sideout:priya', displayName: 'Priya N', dateOfBirth: '1998-11-05' })).data;
    const diego = (await op.record<UserResource>('users.create.fourth', 'POST', '/v1/users', { externalId: 'sideout:diego', displayName: 'Diego A', dateOfBirth: '1989-01-22' })).data;
    const marcusId = marcus?.id ?? '';
    const priyaId = priya?.id ?? '';
    const diegoId = diego?.id ?? '';

    const read = await op.record<UserResource>('users.get', 'GET', `/v1/users/${anaId}`);
    expect(read.status).toBe(200);
    expect(read.data?.id).toBe(anaId);
    const missing = await op.record('users.get.not_found', 'GET', `/v1/users/${unknownUserId()}`);
    expect(missing.status).toBe(400);
    expect(missing.error).toMatchObject({ type: 'invalid_request', code: 'user_not_found' });
    const malformed = await op.record('users.get.validation_failed', 'GET', '/v1/users/not-an-id');
    expect(malformed.error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });

    // ---- devices (signed score attestation, spec section 12 item 1) -------------------
    const device = await op.record<DeviceResource>('users.devices.create', 'POST', `/v1/users/${anaId}/devices`, { publicKey: vectors.publicJwk, label: 'Ana’s phone' });
    expect(device.status).toBe(201);
    expect(device.data).toMatchObject({ userId: anaId, keyId: vectors.keyId, algorithm: 'ES256', publicKey: vectors.publicJwk, label: 'Ana’s phone', revokedAt: null });
    const deviceId = device.data?.id ?? '';
    const sameKey = await op.record<DeviceResource>('users.devices.create.existing', 'POST', `/v1/users/${anaId}/devices`, { publicKey: vectors.publicJwk });
    expect(sameKey.status).toBe(200);
    expect(sameKey.data?.id).toBe(deviceId);
    const privateKey = await op.record('users.devices.create.validation_failed', 'POST', `/v1/users/${anaId}/devices`, { publicKey: vectors.privateJwk });
    expect(privateKey.error).toMatchObject({ type: 'invalid_request', code: 'invalid_input' });
    const devices = await op.record<{ devices: DeviceResource[] }>('users.devices.list', 'GET', `/v1/users/${anaId}/devices`);
    expect(devices.data?.devices.map((d) => d.id)).toEqual([deviceId]);
    const other = await bootstrapTenant(h.database.db);
    const theirs = await client(h, other.plainKey).post<UserResource>('/v1/users', { externalId: 'x' });
    const wrongTenant = await op.record('users.get.permission_error', 'GET', `/v1/users/${theirs.data?.id ?? ''}`);
    expect(wrongTenant.status).toBe(403);
    expect(wrongTenant.error).toMatchObject({ type: 'permission_error', code: 'user_wrong_tenant' });

    // ---- verification and embed tokens ------------------------------------------------
    const verified = await op.record('users.verification.start', 'POST', `/v1/users/${anaId}/verification`, {});
    expect(verified.status).toBe(201);
    expect(verified.data).toMatchObject({ verification: { state: 'verified', provider: 'dev' }, embedToken: { flow: 'identity', userId: anaId, replayed: false } });
    const alreadyVerified = await op.record('users.verification.invalid_state', 'POST', `/v1/users/${anaId}/verification`, {});
    expect(alreadyVerified.status).toBe(409);
    expect(alreadyVerified.error).toMatchObject({ type: 'invalid_state', code: 'already_verified' });
    const embedKey = key('embed');
    const embed = await op.record<EmbedTokenResource>('embed.tokens.create', 'POST', '/v1/embed/tokens', { userId: anaId, flow: 'wallet' }, { idempotencyKey: embedKey });
    expect(embed.status).toBe(201);
    expect(embed.data).toMatchObject({ flow: 'wallet', userId: anaId, replayed: false });
    expect(embed.data?.token).toMatch(/^embt_/);
    const embedReplay = await op.record<EmbedTokenResource>('embed.tokens.create.replay', 'POST', '/v1/embed/tokens', { userId: anaId, flow: 'wallet' }, { idempotencyKey: embedKey });
    expect(embedReplay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(embedReplay.data).toEqual({ ...embed.data, token: null, replayed: true });
    const badFlow = await op.record('embed.tokens.validation_failed', 'POST', '/v1/embed/tokens', { userId: anaId, flow: 'admin' });
    expect(badFlow.error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });

    // ---- wallet and credits -----------------------------------------------------------
    const empty = await op.record('users.wallet.empty', 'GET', `/v1/users/${anaId}/wallet`);
    expect(empty.data).toEqual({ userId: anaId, balances: [{ asset: 'POINTS', balance: '0', accountId: null }, { asset: 'CREDIT', balance: '0', accountId: null }] });
    for (const [name, userId] of [['ana', anaId], ['marcus', marcusId], ['priya', priyaId], ['diego', diegoId]] as const) {
      const credit = await op.record(`users.credits.${name}`, 'POST', `/v1/users/${userId}/credits`, { asset: 'POINTS', amount: '1000', description: 'welcome points' });
      expect(credit.status).toBe(201);
      expect(credit.data).toMatchObject({ userId, asset: 'POINTS', amount: '1000', balance: '1000' });
    }
    const wallet = await op.record('users.wallet', 'GET', `/v1/users/${anaId}/wallet`);
    expect(wallet.data).toMatchObject({ balances: [{ asset: 'POINTS', balance: '1000' }, { asset: 'CREDIT', balance: '0' }] });
    const scopeless = new Recorder(plain);
    const forbidden = await scopeless.record('users.credits.permission_error', 'POST', `/v1/users/${anaId}/credits`, { asset: 'POINTS', amount: '1' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.error).toMatchObject({ type: 'permission_error', code: 'operator_scope_required' });
    const badAmount = await op.record('users.credits.validation_failed', 'POST', `/v1/users/${anaId}/credits`, { asset: 'POINTS', amount: '-5' });
    expect(badAmount.error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });

    // ---- contests ---------------------------------------------------------------------
    const definition = { externalId: 'sideout:doubles-1', kind: 'tournament', title: 'Saturday doubles', asset: 'POINTS', entryAmount: '100', maxParticipants: 8, prizeStructure: { type: 'percentage_split', percentages: [50, 30, 20] } };
    const created = await op.record<ContestResource>('contests.create', 'POST', '/v1/contests', definition);
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ state: 'draft', entryAmount: '100', escrowBalance: '0', participantCount: 0, eligibilityRulesetVersion: '2026.09.1' });
    const contestId = created.data?.id ?? '';
    const taken = await op.record('contests.create.conflict', 'POST', '/v1/contests', definition);
    expect(taken.status).toBe(409);
    expect(taken.error).toMatchObject({ type: 'conflict', code: 'external_id_taken' });
    const badStructure = await op.record('contests.create.validation_failed', 'POST', '/v1/contests', { ...definition, externalId: 'x2', prizeStructure: { type: 'percentage_split', percentages: [60, 60] } });
    expect(badStructure.status).toBe(400);
    expect(badStructure.error).toMatchObject({ type: 'invalid_request', code: 'invalid_prize_structure' });
    const unstakeable = await op.record('contests.create.stake_limit', 'POST', '/v1/contests', { ...definition, externalId: 'x3', entryAmount: '50001' });
    expect(unstakeable.status).toBe(400);
    expect(unstakeable.error).toMatchObject({ type: 'invalid_request', code: 'entry_amount_above_stake_limit', detail: { perContest: 50_000, rulesetVersion: '2026.09.1' } });
    const fetched = await op.record<ContestResource>('contests.get', 'GET', `/v1/contests/${contestId}`);
    expect(fetched.data?.id).toBe(contestId);

    const opened = await op.record<ContestResource>('contests.open', 'POST', `/v1/contests/${contestId}/open`, {});
    expect(opened.data?.state).toBe('open');
    const reopened = await op.record('contests.open.invalid_state', 'POST', `/v1/contests/${contestId}/open`, {});
    expect(reopened.status).toBe(409);
    expect(reopened.error).toMatchObject({ type: 'invalid_state', code: 'invalid_transition' });

    // ---- entries: eligible, not eligible, unfunded, twice ----------------------------------
    const entered = await op.record<EntryResource>('contests.entries.create', 'POST', `/v1/contests/${contestId}/entries`, { userId: anaId, teamRef: 'team-a', seed: 1 });
    expect(entered.status).toBe(201);
    expect(entered.data).toMatchObject({ participant: { userId: anaId, state: 'entered', teamRef: 'team-a' }, eligibility: { allowed: true, rulesetVersion: '2026.09.1' }, contest: { escrowBalance: '100', participantCount: 1 } });
    await addRestriction(h.database.db, { tenantId: boot.tenantId, userId: priyaId, kind: 'self_exclusion', reason: 'taking a month off', actor: { kind: 'user', ref: priyaId } });
    const excluded = await op.record('contests.entries.not_eligible', 'POST', `/v1/contests/${contestId}/entries`, { userId: priyaId, location: { declaredRegion: 'US-CA' } });
    expect(excluded.status).toBe(403);
    expect(excluded.error).toMatchObject({ type: 'not_eligible', code: 'not_eligible', detail: { reasons: ['self_excluded'], rulesetVersion: '2026.09.1' } });
    expect(excluded.error?.detail?.['requiredAction']).toBeUndefined();
    // The refusal was recorded and committed with the 403 that reported it (spec 4.5), and
    // so was the location the request carried; a user's own restriction shows its reason.
    const refusals = await h.database.db.select().from(eligibilityDecisions).where(and(eq(eligibilityDecisions.userId, priyaId), eq(eligibilityDecisions.contestId, contestId)));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ allowed: false, reasons: ['self_excluded'], rulesetVersion: '2026.09.1' });
    expect(refusals[0]?.requestId).toBe(excluded.headers.get('X-Request-Id'));
    const priyaAfter = await op.record<UserResource>('users.get.restricted', 'GET', `/v1/users/${priyaId}`);
    expect(priyaAfter.data).toMatchObject({ location: { regionCode: 'US-CA', source: 'declared' }, restrictions: [{ kind: 'self_exclusion', reason: 'taking a month off' }] });
    const broke = await op.record('contests.entries.insufficient_funds', 'POST', `/v1/contests/${contestId}/entries`, { userId: marcusId, seed: 2, location: { ip: '203.0.113.9' } });
    expect(broke.status).toBe(201);
    const poor = (await plain.post<UserResource>('/v1/users', { externalId: 'sideout:poor', displayName: 'No Points', dateOfBirth: '1990-01-01' })).data;
    const unfunded = await op.record('contests.entries.insufficient_funds.refused', 'POST', `/v1/contests/${contestId}/entries`, { userId: poor?.id ?? '' });
    expect(unfunded.status).toBe(402);
    expect(unfunded.error).toMatchObject({ type: 'insufficient_funds', code: 'insufficient_funds', detail: { reasons: ['insufficient_balance'], requiredAction: 'add_funds', balance: '0', requested: '100' } });
    // An operator's restriction is visible, its reason is not.
    await addRestriction(h.database.db, { tenantId: boot.tenantId, userId: poor?.id ?? '', kind: 'platform_block', reason: 'risk desk: chargeback pattern', actor: { kind: 'operator', ref: 'ops-1' } });
    const blocked = await op.record<UserResource>('users.get.blocked', 'GET', `/v1/users/${poor?.id ?? ''}`);
    expect(blocked.data?.restrictions).toHaveLength(1);
    expect(blocked.data?.restrictions[0]).toMatchObject({ kind: 'platform_block' });
    expect(blocked.data?.restrictions[0]).not.toHaveProperty('reason');
    expect(JSON.stringify(blocked.raw)).not.toContain('chargeback');
    // The same holds for a kind a user could have placed but an operator did (a cool-off taken by phone).
    await addRestriction(h.database.db, { tenantId: boot.tenantId, userId: poor?.id ?? '', kind: 'cool_off', reason: 'risk desk: by phone', endsAt: new Date(Date.now() + 3_600_000), actor: { kind: 'operator', ref: 'ops-1' } });
    const coolingOff = await plain.get<UserResource>(`/v1/users/${poor?.id ?? ''}`);
    expect(coolingOff.data?.restrictions.map((each) => each.kind)).toEqual(['platform_block', 'cool_off']);
    expect(coolingOff.data?.restrictions.every((each) => !('reason' in each))).toBe(true);
    const twice = await op.record('contests.entries.conflict', 'POST', `/v1/contests/${contestId}/entries`, { userId: anaId });
    expect(twice.status).toBe(409);
    expect(twice.error).toMatchObject({ type: 'conflict', code: 'already_entered' });
    await op.record('contests.entries.create.third', 'POST', `/v1/contests/${contestId}/entries`, { userId: diegoId, seed: 3 });

    // ---- withdraw ---------------------------------------------------------------------
    const withdrawn = await op.record('contests.entries.withdraw', 'DELETE', `/v1/contests/${contestId}/entries/${diegoId}`, {});
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.data).toMatchObject({ participant: { userId: diegoId, state: 'withdrawn' }, contest: { escrowBalance: '200', participantCount: 2 } });
    const stranger = await op.record('contests.entries.withdraw.invalid_request', 'DELETE', `/v1/contests/${contestId}/entries/${priyaId}`, {});
    expect(stranger.status).toBe(400);
    expect(stranger.error).toMatchObject({ type: 'invalid_request', code: 'not_a_participant' });

    // ---- scores, lock, start ----------------------------------------------------------
    const early = await op.record('contests.scores.invalid_state', 'POST', `/v1/contests/${contestId}/scores`, { scores: [{ userId: anaId, score: 21, attemptFinished: true }] });
    expect(early.status).toBe(409);
    expect(early.error).toMatchObject({ type: 'invalid_state', code: 'scores_not_accepted' });
    expect((await op.record<ContestResource>('contests.lock', 'POST', `/v1/contests/${contestId}/lock`, {})).data?.state).toBe('locked');
    const lateEntry = await op.record('contests.entries.not_eligible.closed', 'POST', `/v1/contests/${contestId}/entries`, { userId: diegoId });
    expect(lateEntry.error).toMatchObject({ type: 'not_eligible', code: 'contest_not_open', detail: { reasons: ['contest_not_open'], rulesetVersion: '2026.09.1' } });
    expect((await op.record<ContestResource>('contests.start', 'POST', `/v1/contests/${contestId}/start`, {})).data?.state).toBe('in_progress');

    // An attested running score: Ana's registered phone (the pinned test key) signs the pinned
    // canonical form for the pinned match at this moment; Marcus's row carries none.
    const signedAt = new Date().toISOString();
    const payload: AttestationPayload = { ...(vectors.payload as unknown as AttestationPayload), timestamp: signedAt, refs: { ...vectors.payload.refs, teamId: 'team-a' } };
    const signingKey = await crypto.subtle.importKey('jwk', { ...vectors.privateJwk, ext: true }, ES256_KEY, false, ['sign']);
    const attestation = { userId: anaId, keyId: vectors.keyId, algorithm: 'ES256', signature: await signAttestation(signingKey, payload), timestamp: signedAt, refs: payload.refs, content: payload.content };
    const attested = await op.record<{ scores: Array<{ attestationState: string; attestation: unknown }> }>('contests.scores.create.attested', 'POST', `/v1/contests/${contestId}/scores`, {
      scores: [
        { userId: anaId, score: 1, attemptFinished: false, sourceRef: vectors.payload.sourceRef, attestation },
        { userId: marcusId, score: 0, attemptFinished: false, sourceRef: vectors.payload.sourceRef },
      ],
    });
    expect(attested.status, JSON.stringify(attested.error)).toBe(201);
    expect(attested.data?.scores.map((s) => s.attestationState)).toEqual(['verified', 'none']);
    const forged = await op.record('contests.scores.invalid_attestation', 'POST', `/v1/contests/${contestId}/scores`, {
      scores: [{ userId: anaId, score: 2, attemptFinished: false, sourceRef: vectors.payload.sourceRef, attestation: { ...attestation, content: { matchId: vectors.payload.sourceRef, sets: [[1, 21, 18], [2, 19, 21], [3, 15, 12]] } } }],
    });
    expect(forged.status).toBe(422);
    expect(forged.error).toMatchObject({ type: 'invalid_attestation', code: 'attestation_signature_invalid' });
    const revoked = await op.record<DeviceResource>('users.devices.revoke', 'POST', `/v1/users/${anaId}/devices/${deviceId}/revoke`, { reason: 'phone lost' });
    expect(revoked.status).toBe(200);
    expect(revoked.data?.revokedAt).not.toBeNull();
    const afterRevoke = await op.record('contests.scores.invalid_attestation.revoked', 'POST', `/v1/contests/${contestId}/scores`, {
      scores: [{ userId: anaId, score: 2, attemptFinished: false, sourceRef: vectors.payload.sourceRef, attestation }],
    });
    expect(afterRevoke.status).toBe(422);
    expect(afterRevoke.error).toMatchObject({ type: 'invalid_attestation', code: 'attestation_device_revoked' });
    const noDevice = await op.record('users.devices.revoke.not_found', 'POST', `/v1/users/${marcusId}/devices/${deviceId}/revoke`, {});
    expect(noDevice.error).toMatchObject({ type: 'invalid_request', code: 'device_not_found' });

    const scored = await op.record<{ contest: ContestResource; scores: unknown[] }>('contests.scores.create', 'POST', `/v1/contests/${contestId}/scores`, {
      scores: [
        { userId: anaId, score: 21, attemptFinished: true, sourceRef: 'match-1' },
        { userId: marcusId, score: 18, attemptFinished: true, sourceRef: 'match-1' },
      ],
    });
    expect(scored.status).toBe(201);
    expect(scored.data?.contest.state).toBe('awaiting_settlement');
    expect(scored.data?.scores).toHaveLength(2);
    const badScore = await op.record('contests.scores.validation_failed', 'POST', `/v1/contests/${contestId}/scores`, { scores: [{ userId: anaId, score: 'twenty' }] });
    expect(badScore.error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });

    // ---- preview and close ------------------------------------------------------------
    const preview = await op.record<PreviewResource>('contests.preview', 'GET', `/v1/contests/${contestId}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ state: 'awaiting_settlement', escrowTotal: '200', payouts: [{ userId: anaId, placement: 1, payout: '125' }, { userId: marcusId, placement: 2, payout: '75' }] });
    const payoutHash = preview.data?.payoutHash ?? '';
    const stale = await op.record('contests.close.conflict', 'POST', `/v1/contests/${contestId}/close`, { payoutHash: 'a'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.error).toMatchObject({ type: 'conflict', code: 'preview_hash_mismatch' });
    const notOperator = await scopeless.record('contests.close.permission_error', 'POST', `/v1/contests/${contestId}/close`, { payoutHash });
    expect(notOperator.status).toBe(403);
    expect(notOperator.error).toMatchObject({ type: 'permission_error', code: 'operator_required' });
    const badHash = await op.record('contests.close.validation_failed', 'POST', `/v1/contests/${contestId}/close`, { payoutHash: 'nope' });
    expect(badHash.error).toMatchObject({ type: 'invalid_request', code: 'validation_failed' });
    const closed = await op.record<SettlementResource>('contests.close', 'POST', `/v1/contests/${contestId}/close`, { payoutHash });
    expect(closed.status).toBe(200);
    expect(closed.data).toMatchObject({ contest: { state: 'settled', escrowBalance: '0' }, payoutHash, results: [{ userId: anaId, placement: 1, payoutAmount: '125' }, { userId: marcusId, placement: 2, payoutAmount: '75' }] });
    expect(closed.data?.journalEntryId).toMatch(/^je_/);
    const results = await op.record<ResultsResource>('contests.results', 'GET', `/v1/contests/${contestId}/results`);
    expect(results.data).toMatchObject({ contestId, state: 'settled', results: [{ placement: 1 }, { placement: 2 }] });
    const paid = await op.record('users.wallet.paid', 'GET', `/v1/users/${anaId}/wallet`);
    expect((paid.data as { balances: Array<{ asset: string; balance: string }> }).balances[0]).toMatchObject({ asset: 'POINTS', balance: '1025' });
    const previewAfter = await op.record<PreviewResource>('contests.preview.settled', 'GET', `/v1/contests/${contestId}/preview`);
    expect(previewAfter.data?.payoutHash).toBe(payoutHash);

    // ---- finish and void --------------------------------------------------------------
    const second = (await op.record<ContestResource>('contests.create.second', 'POST', '/v1/contests', { ...definition, externalId: 'sideout:doubles-2', kind: 'head_to_head', prizeStructure: { type: 'winner_take_all' } })).data;
    const secondId = second?.id ?? '';
    await op.record('contests.open.second', 'POST', `/v1/contests/${secondId}/open`, {});
    await op.record('contests.entries.create.second', 'POST', `/v1/contests/${secondId}/entries`, { userId: anaId });
    await op.record('contests.lock.second', 'POST', `/v1/contests/${secondId}/lock`, {});
    await op.record('contests.start.second', 'POST', `/v1/contests/${secondId}/start`, {});
    const finished = await op.record<ContestResource>('contests.finish', 'POST', `/v1/contests/${secondId}/finish`, { reason: 'the other player never showed' });
    expect(finished.data?.state).toBe('awaiting_settlement');
    const voided = await op.record('contests.void', 'POST', `/v1/contests/${secondId}/void`, { reason: 'rained out' });
    expect(voided.status).toBe(200);
    expect(voided.data).toMatchObject({ contest: { state: 'voided', escrowBalance: '0' } });
    expect((voided.data as { refundJournalEntryIds: string[] }).refundJournalEntryIds).toHaveLength(1);
    const revoided = await op.record('contests.void.invalid_state', 'POST', `/v1/contests/${secondId}/void`, {});
    expect(revoided.error).toMatchObject({ type: 'invalid_state', code: 'already_voided' });
    const emptyResults = await op.record<ResultsResource>('contests.results.unsettled', 'GET', `/v1/contests/${secondId}/results`);
    expect(emptyResults.data).toMatchObject({ state: 'voided', settledAt: null, results: [] });
    const unknownContest = await op.record('contests.get.not_found', 'GET', `/v1/contests/cnt_${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}`);
    expect(unknownContest.error).toMatchObject({ type: 'invalid_request', code: 'contest_not_found' });

    // ---- idempotency, routing, authentication, health ---------------------------------
    const k = key('contract');
    await op.record('idempotency.first', 'POST', '/v1/users', { externalId: 'sideout:idem' }, { idempotencyKey: k });
    const replayed = await op.record('idempotency.replay', 'POST', '/v1/users', { externalId: 'sideout:idem' }, { idempotencyKey: k });
    expect(replayed.headers.get('Idempotent-Replayed')).toBe('true');
    const reused = await op.record('idempotency.conflict', 'POST', '/v1/users', { externalId: 'sideout:idem-2' }, { idempotencyKey: k });
    expect(reused.error).toMatchObject({ type: 'conflict', code: 'idempotency_key_reused' });
    const noKey = await op.record('idempotency.missing', 'POST', '/v1/users', { externalId: 'sideout:idem-3' }, { idempotencyKey: null });
    expect(noKey.error).toMatchObject({ type: 'invalid_request', code: 'missing_idempotency_key' });
    const notFound = await op.record('routing.not_found', 'GET', '/v1/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.error).toMatchObject({ type: 'invalid_request', code: 'not_found' });

    const anonymous = new Recorder(client(h, undefined));
    const unauthenticated = await anonymous.record('auth.missing_api_key', 'GET', `/v1/users/${anaId}`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.error).toMatchObject({ type: 'authentication_error', code: 'missing_api_key' });
    const browserKey = new Recorder(client(h, boot.publishableKey));
    const publishable = await browserKey.record('auth.secret_key_required', 'GET', `/v1/users/${anaId}`);
    expect(publishable.error).toMatchObject({ type: 'authentication_error', code: 'secret_key_required' });
    const guess = new Recorder(client(h, `sk_sandbox_${'0'.repeat(32)}`));
    const invalidKey = await guess.record('auth.invalid_api_key', 'GET', `/v1/users/${anaId}`);
    expect(invalidKey.error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key' });

    // ---- webhooks and origins (phase 4) ------------------------------------------------
    const hookKey = key('hook');
    const endpoint = await op.record<WebhookEndpointResource>('webhooks.endpoints.create', 'POST', '/v1/webhooks/endpoints', { url: 'https://sideout.example/hooks/purse', subscribedEvents: ['contest.settled', 'wallet.balance.changed'], description: 'Sideout production' }, { idempotencyKey: hookKey });
    expect(endpoint.status).toBe(201);
    expect(endpoint.data?.secret).toMatch(/^whsec_/);
    const endpointId = endpoint.data?.id ?? '';
    const endpointReplay = await op.record<WebhookEndpointResource>('webhooks.endpoints.create.replay', 'POST', '/v1/webhooks/endpoints', { url: 'https://sideout.example/hooks/purse', subscribedEvents: ['contest.settled', 'wallet.balance.changed'], description: 'Sideout production' }, { idempotencyKey: hookKey });
    expect(endpointReplay.data?.secret).toBeNull();
    const plainHook = await op.record('webhooks.endpoints.create.url_not_allowed', 'POST', '/v1/webhooks/endpoints', { url: 'http://sideout.example/hooks/purse', subscribedEvents: ['contest.settled'] });
    expect(plainHook.error).toMatchObject({ type: 'invalid_request', code: 'url_not_allowed' });
    expect((await op.record<{ endpoints: WebhookEndpointResource[] }>('webhooks.endpoints.list', 'GET', '/v1/webhooks/endpoints')).data?.endpoints).toHaveLength(1);
    expect((await op.record<WebhookEndpointResource>('webhooks.endpoints.get', 'GET', `/v1/webhooks/endpoints/${endpointId}`)).data?.secret).toBeNull();
    const patched = await op.record<WebhookEndpointResource>('webhooks.endpoints.update', 'PATCH', `/v1/webhooks/endpoints/${endpointId}`, { subscribedEvents: ['contest.settled', 'contest.voided', 'wallet.balance.changed'] });
    expect(patched.data?.subscribedEvents).toEqual(['contest.settled', 'contest.voided', 'wallet.balance.changed']);
    const rotated = await op.record<WebhookEndpointResource>('webhooks.endpoints.rotate', 'POST', `/v1/webhooks/endpoints/${endpointId}/rotate`, {});
    expect(rotated.data?.secret).toMatch(/^whsec_/);
    const missingEndpoint = await op.record('webhooks.endpoints.get.not_found', 'GET', `/v1/webhooks/endpoints/whe_01a0b493-1a5e-7549-afe4-01a4eee87a8d`);
    expect(missingEndpoint.error).toMatchObject({ type: 'invalid_request', code: 'endpoint_not_found' });
    // The credit below is subscribed: it queues one delivery in the same transaction.
    await op.record('users.credits.hooked', 'POST', `/v1/users/${anaId}/credits`, { asset: 'POINTS', amount: '1' });
    const deliveries = await op.record<{ deliveries: WebhookDeliveryResource[] }>('webhooks.deliveries.list', 'GET', `/v1/webhooks/endpoints/${endpointId}/deliveries`);
    expect(deliveries.data?.deliveries).toHaveLength(1);
    expect(deliveries.data?.deliveries[0]).toMatchObject({ eventType: 'wallet.balance.changed', status: 'pending', attempt: 0, attempts: [] });
    const deliveryId = deliveries.data?.deliveries[0]?.id ?? '';
    expect((await op.record<WebhookDeliveryResource>('webhooks.deliveries.get', 'GET', `/v1/webhooks/deliveries/${deliveryId}`)).data?.id).toBe(deliveryId);
    const replayedDelivery = await op.record<WebhookDeliveryResource>('webhooks.deliveries.replay', 'POST', `/v1/webhooks/deliveries/${deliveryId}/replay`, {});
    expect(replayedDelivery.data).toMatchObject({ replayOf: deliveryId, status: 'pending' });
    const missingDelivery = await op.record('webhooks.deliveries.get.not_found', 'GET', `/v1/webhooks/deliveries/whd_01a0b493-1a5e-7549-afe4-01a4eee87a8d`);
    expect(missingDelivery.error).toMatchObject({ type: 'invalid_request', code: 'delivery_not_found' });
    const internalReplay = await anonymous.record<WebhookDeliveryResource>('internal.webhooks.replay', 'POST', `/v1/internal/webhooks/deliveries/${deliveryId}/replay`, {}, { idempotencyKey: null });
    expect(internalReplay.status).toBe(201);
    expect(internalReplay.data?.replayOf).toBe(deliveryId);
    expect((await anonymous.record<WebhookDeliveryResource>('internal.webhooks.get', 'GET', `/v1/internal/webhooks/deliveries/${deliveryId}`)).data?.id).toBe(deliveryId);

    const origin = await op.record<{ origin: string; origins: string[] }>('origins.add', 'POST', '/v1/origins', { origin: 'https://sideout.example' });
    expect(origin.data).toEqual({ origin: 'https://sideout.example', origins: ['https://sideout.example'] });
    expect((await op.record<{ origins: string[] }>('origins.list', 'GET', '/v1/origins')).data?.origins).toEqual(['https://sideout.example']);
    const badOrigin = await op.record('origins.add.invalid_input', 'POST', '/v1/origins', { origin: 'sideout.example/app' });
    expect(badOrigin.error).toMatchObject({ type: 'invalid_request', code: 'invalid_input' });
    expect((await op.record<{ origins: string[] }>('origins.revoke', 'POST', '/v1/origins/revoke', { origin: 'https://sideout.example' })).data?.origins).toEqual([]);

    // ---- the embed's publishable-key routes ---------------------------------------------
    await op.client.post('/v1/origins', { origin: 'https://sideout.example' });
    const embedState = await browserKey.record<EmbedUserState>('embed.state.anonymous', 'GET', '/v1/embed/state');
    expect(embedState.data).toEqual({ authenticated: false, user: null });
    const embedOrigins = await browserKey.record<{ origins: string[] }>('embed.origins', 'GET', '/v1/embed/origins');
    expect(embedOrigins.data).toEqual({ origins: ['https://sideout.example'] });
    const walletToken = (await op.client.post<EmbedTokenResource>('/v1/embed/tokens', { userId: anaId, flow: 'wallet' })).data?.token ?? '';
    const session = await browserKey.record<EmbedUserState>('embed.session', 'POST', '/v1/embed/session', { embedToken: walletToken, flow: 'wallet', parentOrigin: 'https://sideout.example' });
    expect(session.status).toBe(201);
    expect(session.data?.authenticated).toBe(true);
    const usedToken = await browserKey.record('embed.session.embed_token_used', 'POST', '/v1/embed/session', { embedToken: walletToken, flow: 'wallet', parentOrigin: 'https://sideout.example' });
    expect(usedToken.error).toMatchObject({ type: 'authentication_error', code: 'embed_token_used' });
    const badParent = await browserKey.record('embed.session.origin_not_allowed', 'POST', '/v1/embed/session', { embedToken: `embt_${'a'.repeat(43)}`, flow: 'wallet', parentOrigin: 'https://evil.example' });
    expect(badParent.error).toMatchObject({ type: 'permission_error', code: 'origin_not_allowed' });
    const noSession = await browserKey.record('embed.rewards.session_required', 'GET', '/v1/embed/rewards');
    expect(noSession.error).toMatchObject({ type: 'authentication_error', code: 'session_required' });
    const signin = await browserKey.record<{ sent: boolean; devCode: string | null }>('embed.signin.start', 'POST', '/v1/embed/signin/start', { phoneE164: '+15125550101' });
    expect(signin.data?.sent).toBe(true);
    const badCode = await browserKey.record('embed.signin.verify.invalid_code', 'POST', '/v1/embed/signin/verify', { phoneE164: '+15125550101', code: signin.data?.devCode === '000000' ? '000001' : '000000' });
    expect(badCode.error).toMatchObject({ type: 'authentication_error', code: 'invalid_code' });
    const secretOnEmbed = await op.record('embed.state.publishable_key_required', 'GET', '/v1/embed/state');
    expect(secretOnEmbed.error).toMatchObject({ type: 'authentication_error', code: 'publishable_key_required' });

    const health = await anonymous.record<{ rulesetVersion: string }>('health', 'GET', '/v1/health');
    expect(health.status).toBe(200);
    expect(health.data?.rulesetVersion).toBe('2026.09.1');
    const reconciled = await anonymous.record<{ ok: boolean }>('internal.reconcile', 'GET', '/v1/internal/reconcile');
    expect(reconciled.status).toBe(200);
    expect(reconciled.data?.ok).toBe(true);
    expect((await reconcile(h.database.db)).ok).toBe(true);

    // ---- rate_limited and internal_error take a harness of their own ------------------
    const limitedHarness = harness({ rateLimit: { burst: 1, perSecond: 0.001 } });
    const brokenHarness = harness({ providers: { identity: { name: 'dev', verify: () => Promise.reject(new Error('vendor down')) } } });
    try {
      const limited = new Recorder(client(limitedHarness, boot.plainKey));
      await limited.record('rate.first', 'GET', `/v1/users/${anaId}`);
      const throttled = await limited.record('rate_limited', 'GET', `/v1/users/${anaId}`);
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get('Retry-After')).toMatch(/^\d+$/);
      expect(throttled.error).toMatchObject({ type: 'rate_limited', code: 'too_many_requests' });
      const broken = new Recorder(client(brokenHarness, boot.operatorKey));
      const internal = await broken.record('internal_error', 'POST', `/v1/users/${marcusId}/verification`, {});
      expect(internal.status).toBe(500);
      expect(internal.error).toMatchObject({ type: 'internal_error', code: 'provider_unavailable' });
      expect(JSON.stringify(internal.raw)).not.toContain('vendor down');

      // Every sealed type reached, each with its own codes, at its documented status.
      const all = [op, scopeless, anonymous, browserKey, guess, limited, broken];
      const seen = new Map<ApiErrorType, Set<string>>();
      const statusOf = new Map<ApiErrorType, Set<number>>();
      for (const recorder of all) {
        for (const [type, codes] of recorder.errorTypes()) for (const code of codes) (seen.get(type) ?? seen.set(type, new Set()).get(type))?.add(code);
        for (const fixture of recorder.fixtures) {
          const error = (fixture.response.body as { error?: { type: ApiErrorType } } | null)?.error;
          if (error !== undefined) (statusOf.get(error.type) ?? statusOf.set(error.type, new Set()).get(error.type))?.add(fixture.response.status);
        }
      }
      for (const type of API_ERROR_TYPES) {
        expect(seen.get(type)?.size ?? 0, `${type} is reachable`).toBeGreaterThan(0);
        // Every type answers at its documented status; `invalid_request` also carries the
        // HTTP-level 404 (no such route), 413 and 415, which are refinements of the same type.
        const statuses = [...(statusOf.get(type) ?? [])];
        expect(statuses, `${type} status`).toContain(API_ERROR_STATUS[type]);
        expect(statuses.every((status) => Math.floor(status / 100) === Math.floor(API_ERROR_STATUS[type] / 100)), `${type} status class`).toBe(true);
      }
      const owners = new Map<string, ApiErrorType>();
      for (const [type, codes] of seen) {
        for (const code of codes) {
          expect(owners.get(code), `code ${code} belongs to one type`).toBeUndefined();
          owners.set(code, type);
        }
      }

      const differing = verifyFixtures(all.flatMap((recorder) => recorder.fixtures));
      expect(differing, 'contract fixtures match test/contract/fixtures.json (UPDATE_CONTRACT_FIXTURES=1 to rewrite after a deliberate change)').toEqual([]);
    } finally {
      await limitedHarness.close();
      await brokenHarness.close();
    }
  });
});

export type { Id };
