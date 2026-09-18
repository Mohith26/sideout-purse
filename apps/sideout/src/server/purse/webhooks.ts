import { eq, sql } from 'drizzle-orm';
import { verifyWebhook } from '@purse/sdk';
import { isWebhookEventType, type WebhookEventType } from '@purse/types';
import { newId } from '@repo/ids';
import type { Logger } from '@repo/logger';
import { z } from 'zod';

import type { Db } from '../../db/client';
import { purseEntries, purseWebhookEvents, tournaments, users } from '../../db/schema';
import { webhookEventEnvelopeSchema } from '../../purse/schemas';
import { SYSTEM_ACTOR } from '../actor';
import { writeAudit } from '../audit';
import type { Tx } from '../db';
import { transitionTournament } from '../tournaments';

/**
 * `POST /api/webhooks/purse` (spec 4.9): the signature over the raw body is verified with
 * `verifyWebhook` from `@purse/sdk` (constant time, five-minute window) before anything is
 * parsed; the event is then recorded by its id, which is what makes the receiver
 * idempotent (a redelivery or a replay of the same event is acknowledged and applied no
 * second time); and it is applied in the same transaction that records it, with an audit
 * row, so what was applied and what was received can never disagree. Unknown types and
 * events about things Sideout does not know are acknowledged with 2xx and recorded as
 * ignored: refusing them would only make Purse retry.
 */
export type WebhookOutcome =
  | { status: 200; outcome: 'applied' | 'ignored' | 'duplicate'; eventId: string; eventType: string; detail?: string }
  | { status: 400 | 401 | 503; outcome: 'rejected'; reason: string };

export type WebhookDeps = { db: Db; log: Logger; secret: string | undefined };

const contestData = z.looseObject({ contestId: z.string(), externalId: z.string(), state: z.string(), previousState: z.string().optional(), settledAt: z.string().nullable().optional() });
const entryCreated = z.looseObject({ contestId: z.string(), externalId: z.string(), userId: z.string(), participantId: z.string() });
const entryWithdrawn = z.looseObject({ contestId: z.string(), externalId: z.string(), userId: z.string(), participantId: z.string() });
const verificationUpdated = z.looseObject({ userId: z.string(), externalId: z.string(), verification: z.looseObject({ state: z.string() }) });
const balanceChanged = z.looseObject({ userId: z.string(), asset: z.string(), balance: z.string() });

type Applied = { outcome: 'applied' | 'ignored'; detail?: string };

async function applyContestState(tx: Tx, data: z.infer<typeof contestData>, type: WebhookEventType, now: Date, reservationTtlMs: number): Promise<Applied> {
  const [tournament] = await tx.select().from(tournaments).where(eq(tournaments.purseExternalId, data.externalId)).for('update');
  if (tournament === undefined) return { outcome: 'ignored', detail: `no tournament has external id ${data.externalId}` };
  await tx.update(tournaments).set({ purseContestId: data.contestId, purseContestState: data.state, updatedAt: now }).where(eq(tournaments.id, tournament.id));
  if (type === 'contest.settled' && tournament.status === 'awaiting_settlement') {
    await transitionTournament(tx, { tournament, to: 'settled', actor: SYSTEM_ACTOR, clock: { now, reservationTtlMs } });
    return { outcome: 'applied', detail: 'tournament settled' };
  }
  return { outcome: 'applied', detail: `contest state ${data.state} recorded` };
}

async function applyEntry(tx: Tx, data: z.infer<typeof entryCreated>, state: 'entered' | 'withdrawn', now: Date): Promise<Applied> {
  const [tournament] = await tx.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.purseExternalId, data.externalId));
  if (tournament === undefined) return { outcome: 'ignored', detail: `no tournament has external id ${data.externalId}` };
  const [local] = await tx.select({ id: users.id }).from(users).where(eq(users.purseUserId, data.userId));
  await tx
    .insert(purseEntries)
    .values({ id: newId('pen'), tournamentId: tournament.id, purseUserId: data.userId, userId: local?.id ?? null, purseParticipantId: data.participantId, state, source: 'webhook', createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [purseEntries.tournamentId, purseEntries.purseUserId],
      set: { userId: sql`excluded.user_id`, purseParticipantId: sql`excluded.purse_participant_id`, state: sql`excluded.state`, source: sql`excluded.source`, updatedAt: sql`excluded.updated_at` },
    });
  return { outcome: 'applied', detail: `${state} recorded for ${local === undefined ? 'an unlinked Purse user' : local.id}` };
}

export async function receivePurseWebhook(deps: WebhookDeps, input: { rawBody: string; signatureHeader: string | null; now: Date; reservationTtlMs: number }): Promise<WebhookOutcome> {
  if (deps.secret === undefined) return { status: 503, outcome: 'rejected', reason: 'webhook_secret_not_configured' };
  const verdict = await verifyWebhook(input.rawBody, input.signatureHeader, deps.secret, { now: input.now.getTime() });
  if (!verdict.ok) {
    deps.log.warn('purse webhook rejected', { reason: verdict.reason });
    return { status: 401, outcome: 'rejected', reason: verdict.reason };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, outcome: 'rejected', reason: 'malformed_json' };
  }
  const envelope = webhookEventEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return { status: 400, outcome: 'rejected', reason: 'malformed_event' };
  const event = envelope.data;
  const now = input.now;

  return deps.db.transaction(async (tx) => {
    // Dedupe on the event id: the insert claims it, and a claim that fails is a redelivery.
    const claimed = await tx
      .insert(purseWebhookEvents)
      .values({ id: newId('pwe'), eventId: event.id, eventType: event.type, payload: event, outcome: 'received', receivedAt: now })
      .onConflictDoNothing({ target: purseWebhookEvents.eventId })
      .returning({ id: purseWebhookEvents.id });
    if (claimed.length === 0) return { status: 200, outcome: 'duplicate', eventId: event.id, eventType: event.type };
    const rowId = claimed[0]?.id ?? '';

    let applied: Applied = { outcome: 'ignored', detail: 'unknown event type' };
    if (isWebhookEventType(event.type)) {
      switch (event.type) {
        case 'contest.opened':
        case 'contest.locked':
        case 'contest.settled':
        case 'contest.voided': {
          const data = contestData.safeParse(event.data);
          applied = data.success ? await applyContestState(tx, data.data, event.type, now, input.reservationTtlMs) : { outcome: 'ignored', detail: 'unrecognised data shape' };
          break;
        }
        case 'contest.entry.created': {
          const data = entryCreated.safeParse(event.data);
          applied = data.success ? await applyEntry(tx, data.data, 'entered', now) : { outcome: 'ignored', detail: 'unrecognised data shape' };
          break;
        }
        case 'contest.entry.withdrawn': {
          const data = entryWithdrawn.safeParse(event.data);
          applied = data.success ? await applyEntry(tx, data.data, 'withdrawn', now) : { outcome: 'ignored', detail: 'unrecognised data shape' };
          break;
        }
        case 'user.verification.updated': {
          const data = verificationUpdated.safeParse(event.data);
          if (!data.success) {
            applied = { outcome: 'ignored', detail: 'unrecognised data shape' };
            break;
          }
          const updated = await tx
            .update(users)
            .set({ purseVerificationState: data.data.verification.state, updatedAt: now })
            .where(eq(users.purseExternalId, data.data.externalId))
            .returning({ id: users.id });
          applied = updated.length === 0 ? { outcome: 'ignored', detail: 'no user has that external id' } : { outcome: 'applied', detail: `verification ${data.data.verification.state} for ${updated[0]?.id ?? ''}` };
          break;
        }
        case 'wallet.balance.changed': {
          // Contest value is never stored here (spec 4.2.6): the event is recorded and audited
          // against the linked user, and the profile reads the wallet back from Purse live.
          const data = balanceChanged.safeParse(event.data);
          if (!data.success) {
            applied = { outcome: 'ignored', detail: 'unrecognised data shape' };
            break;
          }
          const [linked] = await tx.select({ id: users.id }).from(users).where(eq(users.purseUserId, data.data.userId));
          applied = linked === undefined ? { outcome: 'ignored', detail: 'no user is linked to that Purse user' } : { outcome: 'applied', detail: `${data.data.asset} balance change noted for ${linked.id}` };
          break;
        }
      }
    }
    await tx.update(purseWebhookEvents).set({ outcome: applied.detail === undefined ? applied.outcome : `${applied.outcome}: ${applied.detail}` }).where(eq(purseWebhookEvents.id, rowId));
    await writeAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: 'purse.webhook_received',
      subjectType: 'purse_event',
      subjectId: event.id,
      detail: { type: event.type, outcome: applied.outcome, ...(applied.detail === undefined ? {} : { detail: applied.detail }) },
      at: now,
    });
    return { status: 200, outcome: applied.outcome, eventId: event.id, eventType: event.type, ...(applied.detail === undefined ? {} : { detail: applied.detail }) };
  });
}
