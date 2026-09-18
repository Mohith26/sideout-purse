import { desc, eq, sql } from 'drizzle-orm';
import type { Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { rulesets, type RulesetRow } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { canonicalJson } from '../ledger/hash';
import { parseRuleset, RulesetError, type Ruleset } from './ruleset';

/**
 * Stored rulesets (decision D9). A version is written once and never edited; making a
 * version active deactivates the previous one in the same transaction, so there is always
 * exactly one active version (the database holds that with a partial unique index).
 */
export type PublishRulesetInput = {
  body: unknown;
  /** Make this version active on publish. */
  activate?: boolean;
  actor?: Actor;
  requestId?: string;
};

export type PublishedRuleset = { ruleset: RulesetRow; created: boolean };

/**
 * Store a version, or return it when the same body is already stored under that version.
 * Idempotent on the version: the seed re-runs it on every deploy.
 */
export async function publishRuleset(db: DbOrTx, input: PublishRulesetInput): Promise<PublishedRuleset> {
  const body = parseRuleset(input.body);
  const actor = input.actor ?? SYSTEM_ACTOR;
  const audit = input.requestId === undefined ? {} : { requestId: input.requestId };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('rulesets', 0))`);
    const [existing] = await tx.select().from(rulesets).where(eq(rulesets.version, body.version));
    let row = existing;
    let created = false;
    if (row === undefined) {
      const [inserted] = await tx.insert(rulesets).values({ version: body.version, body }).returning();
      if (inserted === undefined) throw new Error('rulesets insert returned no row');
      row = inserted;
      created = true;
      await recordAudit(tx, { tenantId: null, actor, action: 'ruleset.published', subject: `ruleset:${row.version}`, before: null, after: { version: row.version, body: row.body }, ...audit });
    } else if (canonicalJson(existing?.body) !== canonicalJson(body)) {
      throw new RulesetError(`Ruleset ${body.version} is already stored with a different body; publish a new version`);
    }
    if (input.activate === true && !row.active) row = await activateWithin(tx, row.version, actor, audit);
    return { ruleset: row, created };
  });
}

export type ActivateRulesetInput = { version: string; actor?: Actor; requestId?: string };

export async function activateRuleset(db: DbOrTx, input: ActivateRulesetInput): Promise<RulesetRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('rulesets', 0))`);
    return activateWithin(tx, input.version, input.actor ?? SYSTEM_ACTOR, input.requestId === undefined ? {} : { requestId: input.requestId });
  });
}

async function activateWithin(tx: DbOrTx, version: string, actor: Actor, audit: { requestId?: string }): Promise<RulesetRow> {
  const [target] = await tx.select().from(rulesets).where(eq(rulesets.version, version)).for('update');
  if (target === undefined) throw new RulesetError(`No ruleset version ${version}`);
  if (target.active) return target;
  const [previous] = await tx.select().from(rulesets).where(eq(rulesets.active, true)).for('update');
  if (previous !== undefined) {
    await tx.update(rulesets).set({ active: false, updatedAt: sql`now()` }).where(eq(rulesets.version, previous.version));
  }
  const [activated] = await tx.update(rulesets).set({ active: true, updatedAt: sql`now()` }).where(eq(rulesets.version, version)).returning();
  if (activated === undefined) throw new Error(`rulesets update of ${version} returned no row`);
  await recordAudit(tx, {
    tenantId: null,
    actor,
    action: 'ruleset.activated',
    subject: `ruleset:${version}`,
    before: previous === undefined ? null : { version: previous.version, active: true },
    after: { version, active: true },
    ...audit,
  });
  return activated;
}

export async function activeRuleset(db: DbOrTx): Promise<Ruleset | undefined> {
  const [row] = await db.select().from(rulesets).where(eq(rulesets.active, true));
  return row === undefined ? undefined : parseRuleset(row.body);
}

/** The active ruleset, or throw: an entry cannot be decided without rules in force. */
export async function requireActiveRuleset(db: DbOrTx): Promise<Ruleset> {
  const ruleset = await activeRuleset(db);
  if (ruleset === undefined) throw new RulesetError('No active ruleset; run pnpm db:seed');
  return ruleset;
}

export async function rulesetByVersion(db: DbOrTx, version: string): Promise<Ruleset | undefined> {
  const [row] = await db.select().from(rulesets).where(eq(rulesets.version, version));
  return row === undefined ? undefined : parseRuleset(row.body);
}

/**
 * The ruleset a contest's entries are judged under: the version pinned on the contest,
 * else the active one (a contest created before any ruleset existed).
 */
export async function rulesetForContest(db: DbOrTx, contest: { eligibilityRulesetVersion: string | null }): Promise<Ruleset> {
  const found = await findRulesetForContest(db, contest);
  if (found === undefined) throw new RulesetError('No active ruleset; run pnpm db:seed');
  return found;
}

/** As `rulesetForContest`, but `undefined` rather than an error when no rules exist at all. */
export async function findRulesetForContest(db: DbOrTx, contest: { eligibilityRulesetVersion: string | null }): Promise<Ruleset | undefined> {
  if (contest.eligibilityRulesetVersion !== null) {
    const pinned = await rulesetByVersion(db, contest.eligibilityRulesetVersion);
    if (pinned !== undefined) return pinned;
  }
  return activeRuleset(db);
}

export async function listRulesets(db: DbOrTx): Promise<RulesetRow[]> {
  return db.select().from(rulesets).orderBy(desc(rulesets.createdAt));
}

export type { Id };
