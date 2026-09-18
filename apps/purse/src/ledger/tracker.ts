import type { ReconcileReport } from './reconcile';

/** What `/health` reports about the most recent `reconcile()` run in this process. */
export type LastReconcile = { at: string; ok: boolean };

export type ReconcileTracker = {
  record(report: ReconcileReport): void;
  last(): LastReconcile | null;
};

/**
 * In-process memory of the last reconcile. One per process, created in `index.ts` and
 * shared by the internal route (which records) and `/health` (which reads). `null` until
 * the first run, never absent, so uptime checks see a stable shape.
 */
export function createReconcileTracker(): ReconcileTracker {
  let last: LastReconcile | null = null;
  return {
    record(report) {
      last = { at: report.ranAt, ok: report.ok };
    },
    last: () => last,
  };
}
