import { z } from 'zod';

import type { ActorKind, BestOf, ConsensusState } from '../db/schema';
import { judgeMatch, judgeSet, setTarget, type MatchVerdict, type SetScore, type Side } from './scoreline';
import { hashScoreline, type Scoreline } from './scoreline-hash';
import type { TransitionVerdict } from './state';

/**
 * The score consensus state machine (spec 5.2) as pure rules. No I/O: `server/consensus.ts`
 * owns the transactions and calls these to decide what to write, and `server/purse/scores.ts`
 * calls the gate before it builds any Purse request.
 *
 *   awaiting_first
 *     └─ one team submits ──► awaiting_second
 *           ├─ other team submits matching hash ──► agreed
 *           └─ other team submits different hash ──► disputed
 *   disputed ──► organizer resolves ──► agreed
 *   agreed ──► Purse accepts the scores ──► pushed_to_purse ──► Purse's replay confirms ──► confirmed
 *
 * Only `agreed` may push to Purse (rule 5): `assertMayPushToPurse` is the gate, and a
 * consensus without the key minted on entering `agreed` never passes it (rule 4).
 */

// ---- Transition table --------------------------------------------------------------------

export const CONSENSUS_EVENTS = ['first_submission', 'matching_submission', 'conflicting_submission', 'organizer_resolution', 'purse_accepted', 'purse_confirmed'] as const;
export type ConsensusEvent = (typeof CONSENSUS_EVENTS)[number];

export type ConsensusEdge = { from: ConsensusState; to: ConsensusState; event: ConsensusEvent; actors: readonly ActorKind[] };

const PLAYER: readonly ActorKind[] = ['player'];
const ORGANIZER: readonly ActorKind[] = ['organizer'];
/** The push runs as the platform (`system`) when a submission triggers it, or as the organizer on a retry. */
const PUSHER: readonly ActorKind[] = ['system', 'organizer'];

export const CONSENSUS_TRANSITIONS: readonly ConsensusEdge[] = [
  { from: 'awaiting_first', to: 'awaiting_second', event: 'first_submission', actors: PLAYER },
  { from: 'awaiting_second', to: 'agreed', event: 'matching_submission', actors: PLAYER },
  { from: 'awaiting_second', to: 'disputed', event: 'conflicting_submission', actors: PLAYER },
  { from: 'disputed', to: 'agreed', event: 'organizer_resolution', actors: ORGANIZER },
  { from: 'agreed', to: 'pushed_to_purse', event: 'purse_accepted', actors: PUSHER },
  { from: 'pushed_to_purse', to: 'confirmed', event: 'purse_confirmed', actors: PUSHER },
];

/** States in which a team may still submit, or replace, its own scoreline. */
export const OPEN_CONSENSUS_STATES: ReadonlySet<ConsensusState> = new Set<ConsensusState>(['awaiting_first', 'awaiting_second']);

/** The one state from which a Purse push may start (rule 5). */
export const PUSHABLE_STATES: ReadonlySet<ConsensusState> = new Set<ConsensusState>(['agreed']);

/**
 * States that block closing the tournament (rule 6): a dispute nobody has settled, an
 * agreed result Purse has not accepted, and an accepted one Purse has not confirmed.
 */
export const CLOSE_BLOCKING_STATES: ReadonlySet<ConsensusState> = new Set<ConsensusState>(['disputed', 'agreed', 'pushed_to_purse']);

/** States an organizer may retry a Purse attempt from: the push itself, or the confirmation of an accepted push. */
export const RETRYABLE_STATES: ReadonlySet<ConsensusState> = new Set<ConsensusState>(['agreed', 'pushed_to_purse']);

export function validateConsensusTransition(from: ConsensusState, to: ConsensusState, actor: ActorKind): TransitionVerdict {
  if (from === to) return { ok: false, code: 'same_state', message: `The consensus is already ${to}.` };
  const outgoing = CONSENSUS_TRANSITIONS.filter((e) => e.from === from);
  if (outgoing.length === 0) return { ok: false, code: 'terminal_state', message: `A consensus that is ${from} cannot change state.` };
  const edge = outgoing.find((e) => e.to === to);
  if (edge === undefined) return { ok: false, code: 'not_a_transition', message: `A consensus cannot go from ${from} to ${to}.` };
  if (!edge.actors.includes(actor)) {
    return { ok: false, code: 'actor_not_permitted', message: `Only ${edge.actors.join(' or ')} may move a consensus from ${from} to ${to}; ${actor} may not.` };
  }
  return { ok: true };
}

/** The event an edge records in the audit row. */
export function consensusEvent(from: ConsensusState, to: ConsensusState): ConsensusEvent | undefined {
  return CONSENSUS_TRANSITIONS.find((e) => e.from === from && e.to === to)?.event;
}

// ---- Errors ------------------------------------------------------------------------------

export const CONSENSUS_ERROR_CODES = ['illegal_scoreline', 'not_on_team', 'already_decided', 'match_not_open', 'invalid_transition'] as const;
export type ConsensusErrorCode = (typeof CONSENSUS_ERROR_CODES)[number];

/** A rule the submission broke; the service maps `code` to the API envelope. */
export class ConsensusError extends Error {
  override readonly name = 'ConsensusError';
  constructor(
    readonly code: ConsensusErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ---- Submitted scorelines: what a team types, from its own side of the net -------------

export const submittedSetSchema = z.strictObject({
  setNumber: z.number().int().min(1).max(3),
  usPoints: z.number().int().min(0).max(99),
  themPoints: z.number().int().min(0).max(99),
});
export type SubmittedSet = z.infer<typeof submittedSetSchema>;

/** Request body of `POST /api/matches/:id/scores`: the submitter's own points first. */
export const submittedScorelineSchema = z.strictObject({ sets: z.array(submittedSetSchema).min(1).max(3) });
export type SubmittedScoreline = z.infer<typeof submittedScorelineSchema>;

/** Body of `POST /api/admin/matches/:id/resolve`: the organizer's scoreline, from team A's side. */
export const resolutionScorelineSchema = z.strictObject({
  sets: z
    .array(z.strictObject({ setNumber: z.number().int().min(1).max(3), teamAPoints: z.number().int().min(0).max(99), teamBPoints: z.number().int().min(0).max(99) }))
    .min(1)
    .max(3),
});

/** Re-express a submitted scoreline in match orientation (team A's points first), ordered by set. */
export function toMatchOrientation(sets: readonly SubmittedSet[], perspective: Side): SetScore[] {
  return [...sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => ({
      setNumber: s.setNumber,
      teamAPoints: perspective === 'a' ? s.usPoints : s.themPoints,
      teamBPoints: perspective === 'a' ? s.themPoints : s.usPoints,
    }));
}

/** The inverse: match-oriented sets as one side would type them. */
export function toPerspective(sets: readonly SetScore[], perspective: Side): SubmittedSet[] {
  return [...sets]
    .sort((x, y) => x.setNumber - y.setNumber)
    .map((s) => ({
      setNumber: s.setNumber,
      usPoints: perspective === 'a' ? s.teamAPoints : s.teamBPoints,
      themPoints: perspective === 'a' ? s.teamBPoints : s.teamAPoints,
    }));
}

export type CanonicalSubmission = {
  /** Match-oriented, ordered sets. */
  sets: SetScore[];
  scoreline: Scoreline;
  hash: string;
  /** Legality verdict; the caller refuses anything not legal before storing it. */
  verdict: MatchVerdict;
};

/**
 * Canonicalize a submission from the submitter's side to the match orientation, judge it,
 * and hash it (rules 1 and 3). Both honest views of one result produce the same hash.
 */
export function canonicalizeSubmission(matchId: string, sets: readonly SubmittedSet[], perspective: Side, bestOf: BestOf): CanonicalSubmission {
  const oriented = toMatchOrientation(sets, perspective);
  const scoreline: Scoreline = { matchId, sets: oriented };
  return { sets: oriented, scoreline, hash: hashScoreline(scoreline, 'a'), verdict: judgeMatch(oriented, bestOf) };
}

/**
 * Refuse an illegal scoreline with a message naming the offending set (rule 3). Beach
 * volleyball gives real constraints, sets to 21, a deciding set to 15, win by two, best of
 * one or three, so no absurd number is stored, let alone pushed.
 */
export function assertLegalScoreline(canonical: CanonicalSubmission, bestOf: BestOf): asserts canonical is CanonicalSubmission & { verdict: { legal: true } } {
  if (canonical.verdict.legal) return;
  const offending = canonical.sets.find((s) => !judgeSet(s.teamAPoints, s.teamBPoints, setTarget(s.setNumber, bestOf)).legal);
  throw new ConsensusError('illegal_scoreline', canonical.verdict.reason, { setNumber: offending?.setNumber ?? null, bestOf });
}

// ---- Deciding the next state ---------------------------------------------------------------

export type LiveSubmission = { teamId: string; hash: string };

export type SubmissionDecision = { next: 'awaiting_second'; replaced: boolean } | { next: 'agreed' } | { next: 'disputed'; differences: SetDifference[]; reason: string };

/**
 * Given the standing (non-superseded) submission from the *other* team, if any, decide
 * where a new submission takes the consensus. Team ids are compared, never users: two
 * submissions from one team can never satisfy both sides (rule 2), they only replace each
 * other.
 */
export function judgeSubmission(input: {
  state: ConsensusState;
  submission: LiveSubmission & { sets: readonly SetScore[] };
  /** The other team's live submission, match-oriented; null when only this team has submitted (or nobody has). */
  standing: (LiveSubmission & { sets: readonly SetScore[] }) | null;
  /** Whether this team already had a live submission that this one replaces. */
  replaces: boolean;
  /** Which side the new submission came from, so a difference is reported as team A's reading against team B's. */
  side: Side;
}): SubmissionDecision {
  if (!OPEN_CONSENSUS_STATES.has(input.state)) {
    throw new ConsensusError('invalid_transition', `No submission is accepted while the consensus is ${input.state}.`, { state: input.state });
  }
  if (input.standing === null) return { next: 'awaiting_second', replaced: input.replaces };
  if (input.standing.teamId === input.submission.teamId) {
    throw new ConsensusError('invalid_transition', 'The standing submission is from the same team; both sides must come from different teams.');
  }
  if (input.standing.hash === input.submission.hash) return { next: 'agreed' };
  const [aSets, bSets] = input.side === 'a' ? [input.submission.sets, input.standing.sets] : [input.standing.sets, input.submission.sets];
  const differences = diffScorelines(aSets, bSets);
  return { next: 'disputed', differences, reason: describeDifferences(differences) };
}

// ---- Differences between two scorelines ----------------------------------------------------

export type SetDifference = {
  setNumber: number;
  /** Match-oriented; null when that side did not report the set at all. */
  a: SetScore | null;
  b: SetScore | null;
};

/** The sets on which two match-oriented scorelines disagree, in set order. */
export function diffScorelines(x: readonly SetScore[], y: readonly SetScore[]): SetDifference[] {
  const numbers = [...new Set([...x, ...y].map((s) => s.setNumber))].sort((p, q) => p - q);
  const out: SetDifference[] = [];
  for (const n of numbers) {
    const a = x.find((s) => s.setNumber === n) ?? null;
    const b = y.find((s) => s.setNumber === n) ?? null;
    if (a !== null && b !== null && a.teamAPoints === b.teamAPoints && a.teamBPoints === b.teamBPoints) continue;
    out.push({ setNumber: n, a, b });
  }
  return out;
}

/** Neutral, factual wording for `match_consensus.disputed_reason`: what differs, never who is wrong. */
export function describeDifferences(differences: readonly SetDifference[]): string {
  if (differences.length === 0) return 'The scorelines differ.';
  const fmt = (s: SetScore | null) => (s === null ? 'not reported' : `${s.teamAPoints}–${s.teamBPoints}`);
  return differences.map((d) => `Set ${d.setNumber} differs: ${fmt(d.a)} vs ${fmt(d.b)}`).join('; ');
}

// ---- Entering `agreed` -----------------------------------------------------------------------

/**
 * The idempotency key is minted exactly once, the first time the consensus reaches
 * `agreed`, and every later Purse attempt reuses it (rule 4). Given an existing key this
 * returns it untouched and never calls `mint`.
 */
export function idempotencyKeyFor(existing: string | null, mint: () => string): string {
  return existing ?? mint();
}

/** What a consensus needs to have been entered as `agreed`. */
export type AgreedOutcome = { winner: Side; winnerTeamId: string; sets: SetScore[]; hash: string };

export function agreedOutcome(match: { id: string; teamAId: string | null; teamBId: string | null; bestOf: BestOf }, sets: readonly SetScore[]): AgreedOutcome {
  const verdict = judgeMatch(sets, match.bestOf);
  if (!verdict.legal) throw new ConsensusError('illegal_scoreline', verdict.reason);
  const winnerTeamId = verdict.winner === 'a' ? match.teamAId : match.teamBId;
  if (winnerTeamId === null) throw new ConsensusError('invalid_transition', `Match ${match.id} does not have both teams; nothing can be agreed.`);
  const ordered = [...sets].sort((x, y) => x.setNumber - y.setNumber).map((s) => ({ setNumber: s.setNumber, teamAPoints: s.teamAPoints, teamBPoints: s.teamBPoints }));
  return { winner: verdict.winner, winnerTeamId, sets: ordered, hash: hashScoreline({ matchId: match.id, sets: ordered }, 'a') };
}

// ---- The Purse gate ---------------------------------------------------------------------------

export class PursePushRefused extends Error {
  override readonly name = 'PursePushRefused';
  constructor(
    readonly code: 'not_agreed' | 'not_retryable' | 'missing_idempotency_key',
    message: string,
  ) {
    super(message);
  }
}

type ConsensusGateInput = { matchId: string; state: ConsensusState; idempotencyKey: string | null };

export type PushableConsensus = ConsensusGateInput & { state: 'agreed'; idempotencyKey: string };
export type RetryableConsensus = ConsensusGateInput & { state: 'agreed' | 'pushed_to_purse'; idempotencyKey: string };

function assertMintedKey(consensus: ConsensusGateInput): asserts consensus is ConsensusGateInput & { idempotencyKey: string } {
  if (consensus.idempotencyKey === null || consensus.idempotencyKey.length === 0) {
    throw new PursePushRefused('missing_idempotency_key', `Match ${consensus.matchId} consensus has no idempotency key; it was never entered as agreed.`);
  }
}

/**
 * Only `agreed` may push to Purse (rule 5), asserted in code, not by convention: the push
 * calls this before building any request. Nothing else passes, and a consensus without
 * its minted key never does.
 */
export function assertMayPushToPurse(consensus: ConsensusGateInput): asserts consensus is PushableConsensus {
  if (!PUSHABLE_STATES.has(consensus.state)) {
    throw new PursePushRefused('not_agreed', `Match ${consensus.matchId} consensus is ${consensus.state}; only an agreed scoreline is pushed to Purse.`);
  }
  assertMintedKey(consensus);
}

/**
 * An organizer's retry: the same push under the same key from `agreed` (the push never
 * landed), or the confirmation alone from `pushed_to_purse` (the push landed, the replay
 * that confirms it did not). Named apart from the first-push gate so a retry is never
 * mistaken for a first write.
 */
export function assertMayRetryPurse(consensus: ConsensusGateInput): asserts consensus is RetryableConsensus {
  if (!RETRYABLE_STATES.has(consensus.state)) {
    throw new PursePushRefused('not_retryable', `Match ${consensus.matchId} consensus is ${consensus.state}; only an agreed or pushed scoreline is retried.`);
  }
  assertMintedKey(consensus);
}

// ---- Audit vocabulary shared by the service and the seed --------------------------------------

export const CONSENSUS_AUDIT = {
  /** A scoreline was recorded (subject: match). */
  scoreSubmitted: 'score.submitted',
  /** An earlier row from the same team was superseded (subject: match). */
  scoreSuperseded: 'score.superseded',
  /** The consensus moved (subject: match; detail carries from, to and the event). */
  stateChanged: 'consensus.state_changed',
  /** A Purse push was refused or failed; the consensus stays where it was (subject: match). */
  pushFailed: 'consensus.push_failed',
} as const;
