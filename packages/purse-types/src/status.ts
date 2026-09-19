/**
 * The public status feed (system spec section 12, stretch item 5): what `GET /v1/status`
 * on the Purse API answers and the console's `/status` page renders. It is read by
 * anyone, so it is the stored result of the last `reconcile()` run and the run history,
 * never a live run, and it carries nothing tenant-shaped: no balances, no names, no
 * counts. A failing invariant is named by its id and its name and nothing else; the
 * detail sentence an operator reads on the console panel stays behind the console's
 * session.
 */

/** `ok` and `failed` are the stored outcome; `unknown` is an invariant no run has checked yet. */
export const STATUS_INVARIANT_STATES = ['ok', 'failed', 'not_applicable', 'unknown'] as const;
export type StatusInvariantState = (typeof STATUS_INVARIANT_STATES)[number];

export type StatusInvariantResource = { id: string; name: string; status: StatusInvariantState };

/** Where a recorded run came from: the 15-minute job, the internal route, the console panel, the CLI, or a test. */
export const RECONCILE_RUN_SOURCES = ['schedule', 'internal', 'console', 'cli', 'test'] as const;
export type ReconcileRunSource = (typeof RECONCILE_RUN_SOURCES)[number];

/** One recorded run: its outcome, when, from where, how long, and the ids of what failed (empty when `ok`). */
export type ReconcileRunResource = { ok: boolean; source: ReconcileRunSource; ranAt: string; durationMs: number; failed: string[] };

export type PublicStatusResource = {
  /** `ok` when the last run was clean, `failing` when it found a violation, `unknown` before the first run. */
  status: 'ok' | 'failing' | 'unknown';
  sha: string;
  migrations: { applied: number; available: number; pending: number };
  rulesetVersion: string | null;
  sdkVersion: string;
  /** Every invariant of the registry, with the outcome the last run recorded for it. */
  invariants: StatusInvariantResource[];
  lastRun: ReconcileRunResource | null;
  /** The most recent runs, newest first, at most `STATUS_RUN_HISTORY`. */
  runs: ReconcileRunResource[];
  /** When this answer was assembled; a cached answer keeps the instant it was built at. */
  generatedAt: string;
};

export const STATUS_RUN_HISTORY = 20;
