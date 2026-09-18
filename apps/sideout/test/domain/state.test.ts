import { describe, expect, it } from 'vitest';

import { ACTOR_KINDS, MATCH_STATUSES, TOURNAMENT_STATUSES } from '../../src/db/schema';
import {
  isMatchComplete,
  MATCH_TRANSITIONS,
  TOURNAMENT_TRANSITIONS,
  validateMatchTransition,
  validateTournamentTransition,
} from '../../src/domain/state';

describe('tournament transitions', () => {
  it('the matrix covers every status and every transition it lists is reachable by its actor', () => {
    for (const from of TOURNAMENT_STATUSES) {
      for (const to of TOURNAMENT_STATUSES) {
        for (const actor of ACTOR_KINDS) {
          const verdict = validateTournamentTransition(from, to, actor);
          const allowed = TOURNAMENT_TRANSITIONS[from][to];
          if (from === to) expect(verdict).toMatchObject({ ok: false, code: 'same_state' });
          else if (Object.keys(TOURNAMENT_TRANSITIONS[from]).length === 0) expect(verdict).toMatchObject({ ok: false, code: 'terminal_state' });
          else if (allowed === undefined) expect(verdict).toMatchObject({ ok: false, code: 'not_a_transition' });
          else if (!allowed.includes(actor)) expect(verdict).toMatchObject({ ok: false, code: 'actor_not_permitted' });
          else expect(verdict).toEqual({ ok: true });
        }
      }
    }
  });

  it('follows the happy path for an organizer and reserves settled for the system', () => {
    expect(validateTournamentTransition('draft', 'registration_open', 'organizer')).toEqual({ ok: true });
    expect(validateTournamentTransition('registration_open', 'registration_closed', 'organizer')).toEqual({ ok: true });
    expect(validateTournamentTransition('registration_closed', 'live', 'organizer')).toEqual({ ok: true });
    expect(validateTournamentTransition('live', 'awaiting_settlement', 'organizer')).toEqual({ ok: true });
    expect(validateTournamentTransition('awaiting_settlement', 'settled', 'organizer')).toMatchObject({ ok: false, code: 'actor_not_permitted' });
    expect(validateTournamentTransition('awaiting_settlement', 'settled', 'system')).toEqual({ ok: true });
    expect(validateTournamentTransition('draft', 'live', 'organizer')).toMatchObject({ ok: false, code: 'not_a_transition' });
    expect(validateTournamentTransition('settled', 'cancelled', 'organizer')).toMatchObject({ ok: false, code: 'terminal_state' });
    expect(validateTournamentTransition('live', 'live', 'organizer')).toMatchObject({ ok: false, code: 'same_state' });
    expect(validateTournamentTransition('registration_open', 'registration_closed', 'player')).toMatchObject({ ok: false, code: 'actor_not_permitted' });
  });
});

describe('match transitions', () => {
  it('final and disputed are system-only, forfeited is organizer-only, terminal states stay put', () => {
    for (const from of MATCH_STATUSES) {
      for (const actor of ACTOR_KINDS) {
        for (const to of ['final', 'disputed'] as const) {
          const verdict = validateMatchTransition(from, to, actor);
          if (verdict.ok) expect(actor).toBe('system');
        }
        const forfeit = validateMatchTransition(from, 'forfeited', actor);
        if (forfeit.ok) expect(actor).toBe('organizer');
      }
    }
    for (const from of ['final', 'forfeited', 'bye'] as const) {
      expect(isMatchComplete(from)).toBe(true);
      expect(Object.keys(MATCH_TRANSITIONS[from])).toEqual([]);
      for (const to of MATCH_STATUSES) {
        if (to === from) continue;
        expect(validateMatchTransition(from, to, 'system')).toMatchObject({ ok: false, code: 'terminal_state' });
      }
    }
    expect(isMatchComplete('awaiting_scores')).toBe(false);
  });

  it('walks the consensus path and the forfeit path', () => {
    expect(validateMatchTransition('scheduled', 'in_progress', 'player')).toEqual({ ok: true });
    expect(validateMatchTransition('in_progress', 'awaiting_scores', 'player')).toEqual({ ok: true });
    expect(validateMatchTransition('awaiting_scores', 'disputed', 'system')).toEqual({ ok: true });
    expect(validateMatchTransition('disputed', 'final', 'system')).toEqual({ ok: true });
    expect(validateMatchTransition('awaiting_scores', 'final', 'organizer')).toMatchObject({ ok: false, code: 'actor_not_permitted' });
    expect(validateMatchTransition('in_progress', 'forfeited', 'organizer')).toEqual({ ok: true });
    expect(validateMatchTransition('scheduled', 'bye', 'organizer')).toMatchObject({ ok: false, code: 'actor_not_permitted' });
  });
});
