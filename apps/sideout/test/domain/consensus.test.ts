import { describe, expect, it, vi } from 'vitest';

import { ACTOR_KINDS, CONSENSUS_STATES, type ActorKind, type ConsensusState } from '../../src/db/schema';
import {
  agreedOutcome,
  assertLegalScoreline,
  assertMayPushToPurse,
  assertMayRetryPurse,
  canonicalizeSubmission,
  CLOSE_BLOCKING_STATES,
  CONSENSUS_TRANSITIONS,
  ConsensusError,
  consensusEvent,
  describeDifferences,
  diffScorelines,
  idempotencyKeyFor,
  judgeSubmission,
  OPEN_CONSENSUS_STATES,
  PursePushRefused,
  PUSHABLE_STATES,
  RETRYABLE_STATES,
  submittedScorelineSchema,
  toMatchOrientation,
  toPerspective,
  validateConsensusTransition,
} from '../../src/domain/consensus';
import { canonicalizeScoreline, hashScoreline } from '../../src/domain/scoreline-hash';

describe('consensus transition table (spec 5.2)', () => {
  // Rows: from; columns: to. Cell = the actor kinds allowed; absent = illegal.
  const table: Record<ConsensusState, Partial<Record<ConsensusState, readonly ActorKind[]>>> = {
    awaiting_first: { awaiting_second: ['player'] },
    awaiting_second: { agreed: ['player'], disputed: ['player'] },
    disputed: { agreed: ['organizer'] },
    agreed: { pushed_to_purse: ['system', 'organizer'] },
    pushed_to_purse: { confirmed: ['system', 'organizer'] },
    confirmed: {},
  };

  it('matches the documented matrix for every (from, to, actor) triple', () => {
    for (const from of CONSENSUS_STATES) {
      for (const to of CONSENSUS_STATES) {
        for (const kind of ACTOR_KINDS) {
          const allowed = table[from][to]?.includes(kind) ?? false;
          const verdict = validateConsensusTransition(from, to, kind);
          expect(verdict.ok, `${from} → ${to} as ${kind}`).toBe(allowed);
          if (!verdict.ok) expect(verdict.code).toBe(from === to ? 'same_state' : from === 'confirmed' ? 'terminal_state' : table[from][to] === undefined ? 'not_a_transition' : 'actor_not_permitted');
        }
      }
    }
    expect(CONSENSUS_TRANSITIONS).toHaveLength(6);
    expect(consensusEvent('awaiting_second', 'disputed')).toBe('conflicting_submission');
    expect(consensusEvent('confirmed', 'agreed')).toBeUndefined();
  });

  it('names the states that are open, that block a close, that may push, and that may retry', () => {
    expect([...OPEN_CONSENSUS_STATES].sort()).toEqual(['awaiting_first', 'awaiting_second']);
    expect([...CLOSE_BLOCKING_STATES].sort()).toEqual(['agreed', 'disputed', 'pushed_to_purse']);
    expect([...PUSHABLE_STATES]).toEqual(['agreed']);
    expect([...RETRYABLE_STATES].sort()).toEqual(['agreed', 'pushed_to_purse']);
  });

  it('never lets a player leave disputed, never lets anyone skip agreed, and never reopens a confirmed result', () => {
    expect(validateConsensusTransition('disputed', 'agreed', 'player').ok).toBe(false);
    expect(validateConsensusTransition('awaiting_second', 'pushed_to_purse', 'system').ok).toBe(false);
    expect(validateConsensusTransition('awaiting_first', 'agreed', 'player').ok).toBe(false);
    expect(validateConsensusTransition('agreed', 'confirmed', 'system').ok).toBe(false);
    expect(validateConsensusTransition('confirmed', 'agreed', 'organizer').ok).toBe(false);
  });
});

describe('canonicalization (rule 1)', () => {
  const matchId = 'mch_1';
  const aView = [
    { setNumber: 1, usPoints: 21, themPoints: 18 },
    { setNumber: 2, usPoints: 19, themPoints: 21 },
    { setNumber: 3, usPoints: 15, themPoints: 12 },
  ];
  // Team B typed the same result from its own side, sets out of order.
  const bView = [
    { setNumber: 3, usPoints: 12, themPoints: 15 },
    { setNumber: 1, usPoints: 18, themPoints: 21 },
    { setNumber: 2, usPoints: 21, themPoints: 19 },
  ];

  it('hashes both honest views of one result identically', () => {
    const a = canonicalizeSubmission(matchId, aView, 'a', 3);
    const b = canonicalizeSubmission(matchId, bView, 'b', 3);
    expect(a.hash).toBe(b.hash);
    expect(a.sets).toEqual(b.sets);
    expect(a.hash).toBe(hashScoreline({ matchId, sets: a.sets }, 'a'));
    expect(a.verdict).toMatchObject({ legal: true, winner: 'a' });
    expect(canonicalizeScoreline({ matchId, sets: a.sets })).toBe('{"matchId":"mch_1","sets":[[1,21,18],[2,19,21],[3,15,12]]}');
    expect(hashScoreline({ matchId, sets: a.sets })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a different set-3 total differently, and a different match differently', () => {
    const a = canonicalizeSubmission(matchId, aView, 'a', 3);
    const [first, second, third] = bView;
    if (first === undefined || second === undefined || third === undefined) throw new Error('fixture');
    const b = canonicalizeSubmission(matchId, [{ ...first, usPoints: 10 }, second, third], 'b', 3);
    expect(a.hash).not.toBe(b.hash);
    expect(canonicalizeSubmission('mch_2', aView, 'a', 3).hash).not.toBe(a.hash);
  });

  it('round-trips a perspective', () => {
    const oriented = toMatchOrientation(bView, 'b');
    expect(toPerspective(oriented, 'b')).toEqual([...bView].sort((x, y) => x.setNumber - y.setNumber));
    expect(toPerspective(oriented, 'a')).toEqual(aView);
  });

  it('rejects an illegal scoreline naming the offending set, before anything is stored (rule 3)', () => {
    const bad = canonicalizeSubmission(matchId, [{ setNumber: 1, usPoints: 21, themPoints: 20 }], 'a', 1);
    expect(() => assertLegalScoreline(bad, 1)).toThrow(ConsensusError);
    try {
      assertLegalScoreline(bad, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(ConsensusError);
      const e = error as ConsensusError;
      expect(e.code).toBe('illegal_scoreline');
      expect(e.message).toMatch(/Set 1: Sets are won by 2/);
      expect(e.detail).toMatchObject({ setNumber: 1, bestOf: 1 });
    }
    const unfinished = canonicalizeSubmission(matchId, [{ setNumber: 1, usPoints: 21, themPoints: 18 }], 'a', 3);
    expect(() => assertLegalScoreline(unfinished, 3)).toThrow(/Nobody has won 2 set/);
    const thirdSetTo21 = canonicalizeSubmission(
      matchId,
      [
        { setNumber: 1, usPoints: 21, themPoints: 18 },
        { setNumber: 2, usPoints: 19, themPoints: 21 },
        { setNumber: 3, usPoints: 21, themPoints: 15 },
      ],
      'a',
      3,
    );
    expect(() => assertLegalScoreline(thirdSetTo21, 3)).toThrow(/Set 3: Past 15/);
    const absurd = submittedScorelineSchema.safeParse({ sets: [{ setNumber: 1, usPoints: 1000, themPoints: 0 }] });
    expect(absurd.success).toBe(false);
    expect(submittedScorelineSchema.safeParse({ sets: [] }).success).toBe(false);
    expect(submittedScorelineSchema.safeParse({ sets: [{ setNumber: 1, usPoints: 21, themPoints: 19, extra: 1 }] }).success).toBe(false);
  });
});

describe('judgeSubmission (rule 2)', () => {
  const sets = [{ setNumber: 1, teamAPoints: 21, teamBPoints: 18 }];
  const other = [{ setNumber: 1, teamAPoints: 21, teamBPoints: 16 }];

  it('first submission waits on the other team', () => {
    expect(judgeSubmission({ state: 'awaiting_first', submission: { teamId: 't1', hash: 'h', sets }, standing: null, replaces: false, side: 'a' })).toEqual({ next: 'awaiting_second', replaced: false });
  });

  it('a resubmission from the same team stays awaiting_second and only replaces', () => {
    expect(judgeSubmission({ state: 'awaiting_second', submission: { teamId: 't1', hash: 'h2', sets }, standing: null, replaces: true, side: 'a' })).toEqual({ next: 'awaiting_second', replaced: true });
    // A caller that mistook the same team's row for the other side is refused outright.
    expect(() => judgeSubmission({ state: 'awaiting_second', submission: { teamId: 't1', hash: 'h', sets }, standing: { teamId: 't1', hash: 'h', sets }, replaces: true, side: 'a' })).toThrow(/different teams/);
  });

  it('the other team agrees by hash equality and disputes by inequality, with the differing sets recorded', () => {
    expect(judgeSubmission({ state: 'awaiting_second', submission: { teamId: 't2', hash: 'h', sets }, standing: { teamId: 't1', hash: 'h', sets }, replaces: false, side: 'b' })).toEqual({ next: 'agreed' });
    const disputed = judgeSubmission({ state: 'awaiting_second', submission: { teamId: 't2', hash: 'x', sets: other }, standing: { teamId: 't1', hash: 'h', sets }, replaces: false, side: 'b' });
    expect(disputed).toEqual({
      next: 'disputed',
      reason: 'Set 1 differs: 21–18 vs 21–16',
      differences: [{ setNumber: 1, a: sets[0], b: other[0] }],
    });
  });

  it('accepts nothing once the consensus has left the open states', () => {
    for (const state of ['disputed', 'agreed', 'pushed_to_purse', 'confirmed'] as const) {
      expect(() => judgeSubmission({ state, submission: { teamId: 't2', hash: 'h', sets }, standing: null, replaces: false, side: 'a' })).toThrow(ConsensusError);
    }
  });
});

describe('differences', () => {
  const x = [
    { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
    { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
    { setNumber: 3, teamAPoints: 15, teamBPoints: 12 },
  ];
  it('lists only the sets that differ, including one side not reporting a set, in neutral words', () => {
    const [x1, x2, x3] = x;
    if (x1 === undefined || x2 === undefined || x3 === undefined) throw new Error('fixture');
    const y = [x1, x2, { setNumber: 3, teamAPoints: 15, teamBPoints: 10 }];
    expect(diffScorelines(x, y)).toEqual([{ setNumber: 3, a: x3, b: y[2] }]);
    expect(describeDifferences(diffScorelines(x, y))).toBe('Set 3 differs: 15–12 vs 15–10');
    expect(diffScorelines(x, x)).toEqual([]);
    expect(describeDifferences(diffScorelines(x, x.slice(0, 2)))).toBe('Set 3 differs: 15–12 vs not reported');
    expect(describeDifferences([])).toBe('The scorelines differ.');
    expect(describeDifferences(diffScorelines(x, y))).not.toMatch(/wrong|blame|lied/i);
  });
});

describe('entering agreed', () => {
  it('mints the idempotency key exactly once (rule 4)', () => {
    const mint = vi.fn(() => 'fresh');
    expect(idempotencyKeyFor(null, mint)).toBe('fresh');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(idempotencyKeyFor('kept', mint)).toBe('kept');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('derives the winner from the legal scoreline and refuses an illegal one', () => {
    const match = { id: 'mch_1', teamAId: 'tm_1', teamBId: 'tm_2', bestOf: 3 as const };
    const sets = [
      { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
      { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
      { setNumber: 3, teamAPoints: 12, teamBPoints: 15 },
    ];
    const out = agreedOutcome(match, sets);
    expect(out.winner).toBe('b');
    expect(out.winnerTeamId).toBe('tm_2');
    expect(out.sets.map((s) => s.setNumber)).toEqual([1, 2, 3]);
    expect(out.hash).toBe(hashScoreline({ matchId: 'mch_1', sets: out.sets }, 'a'));
    expect(() => agreedOutcome(match, [{ setNumber: 1, teamAPoints: 21, teamBPoints: 18 }])).toThrow(ConsensusError);
    expect(() => agreedOutcome({ ...match, teamBId: null }, out.sets)).toThrow(/both teams/);
  });
});

function refusalCode(fn: () => void): PursePushRefused['code'] | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof PursePushRefused) return error.code;
    throw error;
  }
}

describe('assertMayPushToPurse (rule 5)', () => {
  it('passes agreed with a minted key and nothing else', () => {
    for (const state of CONSENSUS_STATES) {
      const row = { matchId: 'mch_1', state, idempotencyKey: 'k' };
      expect(refusalCode(() => assertMayPushToPurse(row)), state).toBe(state === 'agreed' ? null : 'not_agreed');
    }
  });

  it('refuses an agreed consensus without its key', () => {
    expect(refusalCode(() => assertMayPushToPurse({ matchId: 'mch_1', state: 'agreed', idempotencyKey: null }))).toBe('missing_idempotency_key');
    expect(refusalCode(() => assertMayPushToPurse({ matchId: 'mch_1', state: 'agreed', idempotencyKey: '' }))).toBe('missing_idempotency_key');
  });
});

describe('assertMayRetryPurse', () => {
  it('passes agreed (the push never landed) and pushed_to_purse (the confirmation did not), with the minted key', () => {
    for (const state of CONSENSUS_STATES) {
      const row = { matchId: 'mch_1', state, idempotencyKey: 'k' };
      expect(refusalCode(() => assertMayRetryPurse(row)), state).toBe(RETRYABLE_STATES.has(state) ? null : 'not_retryable');
    }
    expect(refusalCode(() => assertMayRetryPurse({ matchId: 'mch_1', state: 'agreed', idempotencyKey: null }))).toBe('missing_idempotency_key');
  });

  it('a confirmed result is never retried and a dispute is never pushed', () => {
    expect(refusalCode(() => assertMayRetryPurse({ matchId: 'mch_1', state: 'confirmed', idempotencyKey: 'k' }))).toBe('not_retryable');
    expect(refusalCode(() => assertMayPushToPurse({ matchId: 'mch_1', state: 'disputed', idempotencyKey: 'k' }))).toBe('not_agreed');
  });
});
