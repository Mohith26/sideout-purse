import type { ActorKind, MatchStatus, TournamentStatus } from '../db/schema';

/**
 * The two state machines, each a single validator the services call before writing.
 * A transition names the actor kinds allowed to perform it; anything not listed is
 * refused. No route mutates a status directly: `server/tournaments.ts` and
 * `server/matches.ts` go through these and write the audit row in the same transaction.
 */

export type TransitionVerdict =
  | { ok: true }
  | { ok: false; code: 'same_state' | 'terminal_state' | 'not_a_transition' | 'actor_not_permitted'; message: string };

type Matrix<S extends string> = Record<S, Partial<Record<S, readonly ActorKind[]>>>;

/**
 * ```
 * draft ─► registration_open ─► registration_closed ─► live ─► awaiting_settlement ─► settled
 *   │             │                     │  ▲             │              │
 *   │             │                     └──┘ (reopen)    │              │
 *   └─────────────┴─────────────────────┴────────────────┴──────────────┴──► cancelled
 * ```
 * `settled` mirrors Purse closing the contest, so only the system (phase 7's settlement
 * wiring) may enter it; an organizer cannot declare a tournament settled by hand.
 */
export const TOURNAMENT_TRANSITIONS: Matrix<TournamentStatus> = {
  draft: { registration_open: ['organizer'], cancelled: ['organizer'] },
  registration_open: { registration_closed: ['organizer'], cancelled: ['organizer'] },
  registration_closed: { registration_open: ['organizer'], live: ['organizer'], cancelled: ['organizer'] },
  live: { awaiting_settlement: ['organizer'], cancelled: ['organizer'] },
  awaiting_settlement: { settled: ['system'], cancelled: ['organizer'] },
  settled: {},
  cancelled: {},
};

/**
 * ```
 * scheduled ─► in_progress ─► awaiting_scores ─► final
 *     │             │               │    └──► disputed ─► final
 *     │             │               │               │
 *     └─────────────┴───────────────┴───────────────┴──► forfeited
 * scheduled ─► bye (at draw time only)
 * ```
 * `final` and `disputed` belong to phase 7's consensus and are system-only; no route
 * sets them. `forfeited` is the organizer's call. `bye` is written by the draw.
 */
export const MATCH_TRANSITIONS: Matrix<MatchStatus> = {
  scheduled: {
    in_progress: ['organizer', 'player', 'system'],
    awaiting_scores: ['organizer', 'player', 'system'],
    forfeited: ['organizer'],
    bye: ['system'],
  },
  in_progress: { awaiting_scores: ['organizer', 'player', 'system'], forfeited: ['organizer'] },
  awaiting_scores: { disputed: ['system'], final: ['system'], forfeited: ['organizer'] },
  disputed: { final: ['system'], forfeited: ['organizer'] },
  final: {},
  forfeited: {},
  bye: {},
};

function validate<S extends string>(matrix: Matrix<S>, subject: string, from: S, to: S, actor: ActorKind): TransitionVerdict {
  if (from === to) return { ok: false, code: 'same_state', message: `The ${subject} is already ${from}.` };
  const outgoing = matrix[from];
  if (Object.keys(outgoing).length === 0) {
    return { ok: false, code: 'terminal_state', message: `A ${subject} that is ${from} cannot change state.` };
  }
  const allowed = outgoing[to];
  if (allowed === undefined) {
    return { ok: false, code: 'not_a_transition', message: `A ${subject} cannot go from ${from} to ${to}.` };
  }
  if (!allowed.includes(actor)) {
    return {
      ok: false,
      code: 'actor_not_permitted',
      message: `Only ${allowed.join(' or ')} may move a ${subject} from ${from} to ${to}; ${actor} may not.`,
    };
  }
  return { ok: true };
}

export function validateTournamentTransition(from: TournamentStatus, to: TournamentStatus, actor: ActorKind): TransitionVerdict {
  return validate(TOURNAMENT_TRANSITIONS, 'tournament', from, to, actor);
}

export function validateMatchTransition(from: MatchStatus, to: MatchStatus, actor: ActorKind): TransitionVerdict {
  return validate(MATCH_TRANSITIONS, 'match', from, to, actor);
}

export const TERMINAL_MATCH_STATUSES: readonly MatchStatus[] = ['final', 'forfeited', 'bye'];

/** A match whose result is known and cannot change. */
export function isMatchComplete(status: MatchStatus): boolean {
  return TERMINAL_MATCH_STATUSES.includes(status);
}
