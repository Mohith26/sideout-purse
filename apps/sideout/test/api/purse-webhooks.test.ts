import { eq } from 'drizzle-orm';
import { signWebhook } from '@purse/sdk';
import { WEBHOOK_SIGNATURE_HEADER } from '@purse/types';
import { newId } from '@repo/ids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as webhook } from '../../src/app/api/webhooks/purse/route';
import { auditLog, purseEntries, purseWebhookEvents, tournaments, users, type Charity, type User } from '../../src/db/schema';
import { loadEnv } from '../../src/env';
import { mintPurseExternalId } from '../../src/server/actor';
import { resetAppContext } from '../../src/server/context';
import { createCharity, createUser, errorOf, json, request, testDatabase, truncateAll, type Database } from '../helpers';

const SECRET = 'whsec_test_secret_for_the_receiver';

describe('POST /api/webhooks/purse', () => {
  let database: Database;
  let charity: Charity;
  let player: User;

  beforeAll(() => {
    database = testDatabase();
  });
  beforeEach(async () => {
    await truncateAll(database);
    resetAppContext({ env: loadEnv({ ...process.env, PURSE_WEBHOOK_SECRET: SECRET }) });
    charity = await createCharity(database);
    player = await createUser(database);
  });
  afterAll(async () => {
    await database.close();
  });

  async function deliver(event: Record<string, unknown>, options: { secret?: string; at?: Date; rawBody?: string } = {}): Promise<Response> {
    const rawBody = options.rawBody ?? JSON.stringify(event);
    const at = options.at ?? new Date();
    const signed = await signWebhook(rawBody, options.secret ?? SECRET, Math.floor(at.getTime() / 1000));
    return webhook(request('POST', '/api/webhooks/purse', { body: rawBody, headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: signed.header } }));
  }

  const stored = () => database.db.select().from(purseWebhookEvents);

  function event(type: string, data: Record<string, unknown>, id = newId('evt')): Record<string, unknown> {
    return { id, type, createdAt: new Date().toISOString(), tenantId: 'tnt_01a0b16a-b475-74d4-b1cb-2dbdc08845a9', data };
  }

  async function settledTournament(status: 'awaiting_settlement' | 'live' = 'awaiting_settlement') {
    const [row] = await database.db
      .insert(tournaments)
      .values({
        id: newId('trn'),
        slug: `close-${Date.now()}`,
        name: 'Close Me',
        beneficiaryId: charity.id,
        venueName: 'v',
        venueCity: 'c',
        venueRegion: 'CA',
        venueTimezone: 'America/Los_Angeles',
        startsAt: new Date(),
        endsAt: new Date(),
        format: 'single_elim',
        division: 'open',
        maxTeams: 4,
        entryDonationCents: 0n,
        fundraisingGoalCents: 0n,
        status,
        purseExternalId: mintPurseExternalId('contest'),
        purseContestId: 'cnt_00000000-0000-7000-8000-000000000001',
      })
      .returning();
    if (row === undefined) throw new Error('insert failed');
    return row;
  }

  it('rejects a bad signature, a stale timestamp and a malformed body, and answers 503 with no secret configured', async () => {
    const good = event('contest.opened', { contestId: 'cnt_x', externalId: 'nope', state: 'open' });
    expect(await errorOf(await deliver(good, { secret: 'whsec_wrong' }))).toMatchObject({ type: 'authentication_error', code: 'signature_mismatch' });
    expect(await errorOf(await deliver(good, { at: new Date(Date.now() - 10 * 60_000) }))).toMatchObject({ type: 'authentication_error', code: 'timestamp_out_of_window' });
    expect(await errorOf(await webhook(request('POST', '/x', { body: JSON.stringify(good), headers: { 'content-type': 'application/json' } })))).toMatchObject({ code: 'malformed_header' });
    expect(await errorOf(await deliver(good, { rawBody: '{not json' }))).toMatchObject({ type: 'invalid_request', code: 'malformed_json' });
    expect(await errorOf(await deliver({ hello: 'world' }))).toMatchObject({ type: 'invalid_request', code: 'malformed_event' });
    // The bytes on the wire are what is verified: a re-serialised body does not pass.
    const tampered = await signWebhook(JSON.stringify(good), SECRET, Math.floor(Date.now() / 1000));
    const response = await webhook(request('POST', '/x', { body: JSON.stringify({ ...good, data: { ...good, tampered: true } }), headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: tampered.header } }));
    expect(response.status).toBe(401);
    expect(await database.db.select().from(purseWebhookEvents)).toHaveLength(0);

    resetAppContext({ env: loadEnv({ ...process.env, PURSE_WEBHOOK_SECRET: undefined }) });
    const unconfigured = await deliver(good);
    expect(unconfigured.status).toBe(503);
    expect(await errorOf(unconfigured)).toMatchObject({ code: 'webhook_secret_not_configured' });
  });

  it('dedupes on the event id: a redelivery is acknowledged and applied no second time', async () => {
    const tournament = await settledTournament();
    const settled = event('contest.settled', { contestId: tournament.purseContestId, externalId: tournament.purseExternalId, kind: 'tournament', asset: 'POINTS', state: 'settled', previousState: 'settling', settledAt: new Date().toISOString() });
    const first = await json<{ outcome: string; detail?: string }>(await deliver(settled));
    expect(first).toMatchObject({ data: { received: true, outcome: 'applied', detail: 'tournament settled' } });
    const [after] = await database.db.select().from(tournaments).where(eq(tournaments.id, tournament.id));
    expect(after?.status).toBe('settled');
    expect(after?.purseContestState).toBe('settled');
    const settledAudit = (await database.db.select().from(auditLog).where(eq(auditLog.subjectId, tournament.id))).find((r) => r.action === 'tournament.status_changed');
    expect(settledAudit).toMatchObject({ actorKind: 'system', detail: { from: 'awaiting_settlement', to: 'settled' } });

    const again = await json(await deliver(settled));
    expect(again).toMatchObject({ data: { outcome: 'duplicate' } });
    expect(await database.db.select().from(purseWebhookEvents)).toHaveLength(1);
    expect((await database.db.select().from(auditLog).where(eq(auditLog.subjectId, tournament.id))).filter((r) => r.action === 'tournament.status_changed')).toHaveLength(1);
    const received = (await database.db.select().from(auditLog)).filter((r) => r.action === 'purse.webhook_received');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ subjectType: 'purse_event', subjectId: settled['id'] });
  });

  it('applies entries, verification and wallet events to the local rows, and ignores unknown types and subjects with 2xx', async () => {
    const tournament = await settledTournament('live');
    await database.db.update(users).set({ purseUserId: 'usr_00000000-0000-7000-8000-000000000009' }).where(eq(users.id, player.id));
    const created = await json(
      await deliver(event('contest.entry.created', { contestId: tournament.purseContestId, externalId: tournament.purseExternalId, userId: 'usr_00000000-0000-7000-8000-000000000009', participantId: 'ent_1', teamRef: null, seed: null, journalEntryId: 'je_1', rulesetVersion: '2026.09.1', reentered: false })),
    );
    expect(created).toMatchObject({ data: { outcome: 'applied' } });
    let [entry] = await database.db.select().from(purseEntries).where(eq(purseEntries.tournamentId, tournament.id));
    expect(entry).toMatchObject({ userId: player.id, purseParticipantId: 'ent_1', state: 'entered', source: 'webhook' });
    await deliver(event('contest.entry.withdrawn', { contestId: tournament.purseContestId, externalId: tournament.purseExternalId, userId: 'usr_00000000-0000-7000-8000-000000000009', participantId: 'ent_1', refundJournalEntryId: 'je_2' }));
    [entry] = await database.db.select().from(purseEntries).where(eq(purseEntries.tournamentId, tournament.id));
    expect(entry?.state).toBe('withdrawn');

    await deliver(event('user.verification.updated', { userId: 'usr_00000000-0000-7000-8000-000000000009', externalId: player.purseExternalId, previousState: 'pending', verification: { state: 'verified', provider: 'dev', verifiedAt: null, reverifyAfter: null } }));
    await deliver(event('wallet.balance.changed', { userId: 'usr_00000000-0000-7000-8000-000000000009', accountId: 'acct_1', asset: 'POINTS', balance: '900', delta: '-100', journalEntryId: 'je_3', entryKind: 'escrow', contestId: tournament.purseContestId }));
    const [after] = await database.db.select().from(users).where(eq(users.id, player.id));
    expect(after?.purseVerificationState).toBe('verified');
    // The balance is never stored (spec 4.2.6); the event is recorded and audited.
    expect(Object.keys(after ?? {})).not.toContain('purseWallet');
    expect((await stored()).find((r) => r.eventType === 'wallet.balance.changed')?.outcome).toMatch(/^applied: POINTS balance change noted/);

    expect(await json(await deliver(event('contest.locked', { contestId: 'cnt_unknown', externalId: 'sideout-contest-unknown', state: 'locked' })))).toMatchObject({ data: { outcome: 'ignored' } });
    expect(await json(await deliver(event('something.new', { whatever: true })))).toMatchObject({ data: { outcome: 'ignored', detail: 'unknown event type' } });
    expect((await stored()).map((e) => e.outcome)).toEqual(expect.arrayContaining(['ignored: unknown event type', expect.stringMatching(/^applied/)]));
  });
});
