import { desc } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { reconcileRuns, type ReconcileRun, type ReconcileRunSource } from '../db/schema';
import { reconcile, type ReconcileReport } from './reconcile';

/**
 * The record of every `reconcile()` run (spec section 10). `/health` reports the newest
 * row as the "last reconcile result" instead of re-running seven invariants on every
 * probe, and the scheduled job (`scripts/reconcile.ts` on a 15-minute cron), the internal
 * route and the console's panel all write here, so the report on `/health` is whatever
 * ran last, wherever it ran. The table is append-only for the runtime
 * (`drizzle/0016_reconcile_run_grants.sql`): a failed run stays on the record.
 */
export type ReconcileSummary = {
  ok: boolean;
  source: ReconcileRunSource;
  ranAt: string;
  durationMs: number;
  /** The ids of the invariants that failed; empty when `ok`. */
  failed: string[];
};

export async function recordReconcileRun(db: DbOrTx, report: ReconcileReport, source: ReconcileRunSource): Promise<ReconcileRun> {
  const [row] = await db
    .insert(reconcileRuns)
    .values({
      id: newId('rcr'),
      ok: report.ok,
      source,
      ranAt: new Date(report.ranAt),
      durationMs: report.durationMs,
      failed: report.invariants.filter((result) => !result.ok).map((result) => result.id),
      report,
    })
    .returning();
  if (row === undefined) throw new Error('reconcile_runs insert returned no row');
  return row;
}

/** Run the invariants and record the outcome in one step; the report is returned whatever it says. */
export async function reconcileAndRecord(db: DbOrTx, source: ReconcileRunSource): Promise<{ report: ReconcileReport; run: ReconcileRun }> {
  const report = await reconcile(db);
  const run = await recordReconcileRun(db, report, source);
  return { report, run };
}

/** The newest recorded run, or `null` on a database no one has reconciled yet. */
export async function lastReconcileRun(db: DbOrTx): Promise<ReconcileSummary | null> {
  const [row] = await db.select().from(reconcileRuns).orderBy(desc(reconcileRuns.ranAt), desc(reconcileRuns.id)).limit(1);
  if (row === undefined) return null;
  return summarise(row);
}

/** The newest `limit` runs, newest first, each with its stored report: the public status feed reads the last one's invariants from it. */
export async function recentReconcileRuns(db: DbOrTx, limit: number): Promise<ReconcileRun[]> {
  return db.select().from(reconcileRuns).orderBy(desc(reconcileRuns.ranAt), desc(reconcileRuns.id)).limit(limit);
}

export function summarise(run: ReconcileRun): ReconcileSummary {
  return { ok: run.ok, source: run.source, ranAt: run.ranAt.toISOString(), durationMs: run.durationMs, failed: run.failed };
}
