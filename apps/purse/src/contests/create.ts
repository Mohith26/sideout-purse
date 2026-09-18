import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { asset as assetEnum, contestKind, contests, settlementPolicy, type Account, type Contest } from '../db/schema';
import { getAccount, openAccount } from '../ledger/accounts';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { prizeStructureSchema, tieBreakRuleSchema } from '../settlement/types';
import { ContestError } from './errors';
import { idempotent } from './idempotency';
import { getContest, lockContest } from './load';
import { TRANSITION_ACTIONS } from './states';

/**
 * Creating and editing a contest. A contest is born in `draft` with its escrow account
 * already open, in one transaction, so there is never a contest without somewhere to hold
 * its entries. `prize_structure` is validated by the settlement engine's own schema on the
 * way in; the engine validates it again on the way out.
 */
const timestampInput = z.union([z.date(), z.iso.datetime({ offset: true }).transform((value) => new Date(value))]);

const definition = {
  kind: z.enum(contestKind.enumValues),
  title: z.string().trim().min(1).max(200),
  entryAmount: z.bigint().positive().max(9_223_372_036_854_775_807n),
  maxParticipants: z.number().int().min(1).max(1_000_000).nullable().optional(),
  prizeStructure: prizeStructureSchema,
  tieBreak: tieBreakRuleSchema.optional(),
  settlementPolicy: z.enum(settlementPolicy.enumValues).optional(),
  opensAt: timestampInput.nullable().optional(),
  locksAt: timestampInput.nullable().optional(),
};

const lockAfterOpen = (value: { opensAt?: Date | null | undefined; locksAt?: Date | null | undefined }) =>
  value.opensAt === undefined || value.opensAt === null || value.locksAt === undefined || value.locksAt === null || value.locksAt > value.opensAt;

export const createContestSchema = z
  .object({
    externalId: z.string().trim().min(1).max(255),
    asset: z.enum(assetEnum.enumValues),
    ...definition,
  })
  .strict()
  .refine(lockAfterOpen, { message: 'locksAt must be after opensAt', path: ['locksAt'] });

export const updateContestSchema = z
  .object({
    kind: definition.kind.optional(),
    title: definition.title.optional(),
    entryAmount: definition.entryAmount.optional(),
    maxParticipants: definition.maxParticipants,
    prizeStructure: definition.prizeStructure.optional(),
    tieBreak: definition.tieBreak,
    settlementPolicy: definition.settlementPolicy,
    opensAt: definition.opensAt,
    locksAt: definition.locksAt,
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'nothing to update' });

export type CreateContestFields = z.input<typeof createContestSchema>;
export type UpdateContestFields = z.input<typeof updateContestSchema>;

export type CreateContestInput = CreateContestFields & {
  tenantId: Id<'tnt'>;
  idempotencyKey: string;
  actor?: Actor;
  requestId?: string;
};

export type CreatedContest = { contest: Contest; escrowAccount: Account; replayed: boolean };

export async function createContest(db: DbOrTx, input: CreateContestInput): Promise<CreatedContest> {
  const { tenantId, idempotencyKey, actor, requestId, ...fields } = input;
  const parsed = parse(createContestSchema, fields);

  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Omit<CreatedContest, 'replayed'>, { contestId: string }>(
      tx,
      { tenantId, key: idempotencyKey, operation: 'contest.create', request: fingerprint(fields) },
      {
        run: async () => {
          const [taken] = await tx
            .select({ id: contests.id })
            .from(contests)
            .where(and(eq(contests.tenantId, tenantId), eq(contests.externalId, parsed.externalId)));
          if (taken !== undefined) {
            throw new ContestError('external_id_taken', `A contest with external_id ${parsed.externalId} already exists`, {
              externalId: parsed.externalId,
              contestId: taken.id,
            });
          }

          const id = newId('cnt');
          const { account } = await openAccount(tx, {
            tenantId,
            kind: 'contest_escrow',
            ownerRef: id,
            asset: parsed.asset,
            actor: actor ?? SYSTEM_ACTOR,
            ...(requestId === undefined ? {} : { requestId }),
          });

          let inserted: Contest | undefined;
          try {
            [inserted] = await tx
              .insert(contests)
              .values({
                id,
                tenantId,
                externalId: parsed.externalId,
                kind: parsed.kind,
                title: parsed.title,
                asset: parsed.asset,
                entryAmount: parsed.entryAmount,
                maxParticipants: parsed.maxParticipants ?? null,
                prizeStructure: parsed.prizeStructure,
                tieBreak: parsed.tieBreak ?? 'split_evenly',
                settlementPolicy: parsed.settlementPolicy ?? 'operator_close',
                opensAt: parsed.opensAt ?? null,
                locksAt: parsed.locksAt ?? null,
                escrowAccountId: account.id,
              })
              .returning();
          } catch (error) {
            throw translateConstraint(error, parsed.externalId);
          }
          if (inserted === undefined) throw new Error('contests insert returned no row');

          await recordAudit(tx, {
            tenantId,
            actor: actor ?? SYSTEM_ACTOR,
            action: TRANSITION_ACTIONS.draft,
            subject: inserted.id,
            before: null,
            after: inserted,
            ...(requestId === undefined ? {} : { requestId }),
          });
          return { value: { contest: inserted, escrowAccount: account }, record: { contestId: inserted.id } };
        },
        replay: async (record) => {
          const contest = await getContest(tx, tenantId, record.contestId);
          return { contest, escrowAccount: await getAccount(tx, contest.escrowAccountId) };
        },
      },
    );
    return { ...value, replayed };
  });
}

export type UpdateContestInput = {
  tenantId: Id<'tnt'>;
  contestId: string;
  patch: UpdateContestFields;
  idempotencyKey: string;
  actor: Actor;
  requestId?: string;
};

export type UpdatedContest = { contest: Contest; replayed: boolean };

/** Edit a draft. Once a contest has left `draft` its definition is frozen (a trigger holds that line for every role). */
export async function updateContest(db: DbOrTx, input: UpdateContestInput): Promise<UpdatedContest> {
  const patch = parse(updateContestSchema, input.patch);
  return db.transaction(async (tx) => {
    const { value, replayed } = await idempotent<Contest, { contestId: string }>(
      tx,
      { tenantId: input.tenantId, key: input.idempotencyKey, operation: 'contest.update', request: { contestId: input.contestId, patch: fingerprint(input.patch) } },
      {
        run: async () => {
          const before = await lockContest(tx, input.tenantId, input.contestId);
          if (before.state !== 'draft') {
            throw new ContestError('invalid_contest_state', `Contest ${before.id} is ${before.state}; only a draft can be edited`, {
              contestId: before.id,
              state: before.state,
              expected: 'draft',
            });
          }
          const merged = { opensAt: patch.opensAt === undefined ? before.opensAt : patch.opensAt, locksAt: patch.locksAt === undefined ? before.locksAt : patch.locksAt };
          if (!lockAfterOpen(merged)) {
            throw new ContestError('invalid_input', 'locksAt must be after opensAt', { contestId: before.id });
          }
          const [after] = await tx
            .update(contests)
            .set({
              ...(patch.kind === undefined ? {} : { kind: patch.kind }),
              ...(patch.title === undefined ? {} : { title: patch.title }),
              ...(patch.entryAmount === undefined ? {} : { entryAmount: patch.entryAmount }),
              ...(patch.maxParticipants === undefined ? {} : { maxParticipants: patch.maxParticipants }),
              ...(patch.prizeStructure === undefined ? {} : { prizeStructure: patch.prizeStructure }),
              ...(patch.tieBreak === undefined ? {} : { tieBreak: patch.tieBreak }),
              ...(patch.settlementPolicy === undefined ? {} : { settlementPolicy: patch.settlementPolicy }),
              ...(patch.opensAt === undefined ? {} : { opensAt: patch.opensAt }),
              ...(patch.locksAt === undefined ? {} : { locksAt: patch.locksAt }),
              updatedAt: sql`now()`,
            })
            .where(eq(contests.id, before.id))
            .returning();
          if (after === undefined) throw new Error(`contests update of ${before.id} returned no row`);
          await recordAudit(tx, {
            tenantId: input.tenantId,
            actor: input.actor,
            action: 'contest.updated',
            subject: before.id,
            before,
            after,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          });
          return { value: after, record: { contestId: after.id } };
        },
        replay: (record) => getContest(tx, input.tenantId, record.contestId),
      },
    );
    return { contest: value, replayed };
  });
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String).join('.') ?? '';
    const code = path.startsWith('prizeStructure') ? 'invalid_prize_structure' : 'invalid_input';
    throw new ContestError(code, `Invalid ${path === '' ? 'input' : path}: ${issue?.message ?? 'unknown'}`, {
      path,
      issues: result.error.issues.map((each) => ({ path: each.path.map(String).join('.'), message: each.message })),
    });
  }
  return result.data;
}

/** Bigints and dates as strings, so the request hash is stable across callers. */
function fingerprint(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner)),
  ) as unknown;
}

function translateConstraint(error: unknown, externalId: string): unknown {
  const cause = error instanceof Error ? error.cause : undefined;
  const pg = cause as { code?: unknown; constraint_name?: unknown } | undefined;
  if (pg?.code === '23505' && pg.constraint_name === 'contests_tenant_id_external_id_key') {
    return new ContestError('external_id_taken', `A contest with external_id ${externalId} already exists`, { externalId });
  }
  return error;
}
