import { sql } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { operatorFlags, type OperatorFlag } from '../db/schema';
import type { Ruleset } from './ruleset';

/**
 * The head-to-head collusion signal (spec 4.6): pairs who have faced each other at least
 * `ruleset.collusion.minMeetings` times, with one side winning at least
 * `ruleset.collusion.oneSidedShare` of those meetings, are flagged for the operator and
 * nothing more. A meeting is a settled `head_to_head` contest with exactly two results
 * and a strict winner (placement 1 against a lower placement); a tie is not a meeting.
 *
 * `collusionPairs` reads the signal for the pairs the given users belong to;
 * `flagCollusion` records it. `executeSettlement` calls `flagCollusion` inside the
 * settlement transaction of a head-to-head contest for the two players it involved, so a
 * signal surfaces the moment the meeting that tips it is recorded.
 */
export type CollusionPair = {
  a: string;
  b: string;
  meetings: number;
  wins: { a: number; b: number };
  /** The larger side's share of the meetings. */
  share: number;
};

export type CollusionInput = { tenantId: Id<'tnt'>; ruleset: Ruleset; users: readonly string[] };

export async function collusionPairs(db: DbOrTx, input: CollusionInput): Promise<CollusionPair[]> {
  const { minMeetings, oneSidedShare } = input.ruleset.collusion;
  if (input.users.length === 0) return [];
  const list = sql.join(
    input.users.map((userId) => sql`${userId}`),
    sql`, `,
  );
  const rows = await db.execute<{ a: string; b: string; meetings: number; a_wins: number }>(sql`
    select pair.a, pair.b, count(*)::int as meetings, sum(case when pair.winner = pair.a then 1 else 0 end)::int as a_wins
    from (
      select c.id, least(w.user_id, l.user_id) as a, greatest(w.user_id, l.user_id) as b, w.user_id as winner
      from contests c
      join contest_results w on w.contest_id = c.id and w.placement = 1
      join contest_results l on l.contest_id = c.id and l.placement > 1
      where c.tenant_id = ${input.tenantId}
        and c.kind = 'head_to_head'
        and c.state = 'settled'
        and (select count(*) from contest_results r where r.contest_id = c.id) = 2
    ) pair
    where pair.a in (${list}) or pair.b in (${list})
    group by pair.a, pair.b
    having count(*) >= ${minMeetings}
    order by pair.a, pair.b
  `);
  return rows
    .map((row) => {
      const bWins = row.meetings - row.a_wins;
      return { a: row.a, b: row.b, meetings: row.meetings, wins: { a: row.a_wins, b: bWins }, share: Math.max(row.a_wins, bWins) / row.meetings };
    })
    .filter((pair) => pair.share >= oneSidedShare);
}

export type CollusionScan = { pairs: CollusionPair[]; flags: OperatorFlag[] };

/** Flag every qualifying pair once (`pair:<a>:<b>`); a pair already flagged, open or reviewed, raises nothing new. */
export async function flagCollusion(db: DbOrTx, input: CollusionInput): Promise<CollusionScan> {
  const pairs = await collusionPairs(db, input);
  const flags: OperatorFlag[] = [];
  for (const pair of pairs) {
    const [flag] = await db
      .insert(operatorFlags)
      .values({
        id: newId('flg'),
        tenantId: input.tenantId,
        kind: 'collusion_signal',
        subject: pair.a,
        dedupeKey: `pair:${pair.a}:${pair.b}`,
        detail: { users: [pair.a, pair.b], meetings: pair.meetings, wins: pair.wins, share: pair.share, minMeetings: input.ruleset.collusion.minMeetings, oneSidedShare: input.ruleset.collusion.oneSidedShare, rulesetVersion: input.ruleset.version },
      })
      .onConflictDoNothing({ target: [operatorFlags.tenantId, operatorFlags.kind, operatorFlags.dedupeKey] })
      .returning();
    if (flag !== undefined) flags.push(flag);
  }
  return { pairs, flags };
}
