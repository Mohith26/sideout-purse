import { describe, expect, it } from 'vitest';

import { judgeMatch, judgeSet, setTarget } from '../../src/domain/scoreline';

/** The refusal reason of a verdict, or '' when it was legal. */
const reason = (verdict: { legal: boolean; reason?: string }): string => (verdict.legal ? '' : (verdict.reason ?? ''));

describe('judgeSet', () => {
  it('accepts regulation and deuce sets', () => {
    expect(judgeSet(21, 18, 21)).toEqual({ legal: true, winner: 'a' });
    expect(judgeSet(19, 21, 21)).toEqual({ legal: true, winner: 'b' });
    expect(judgeSet(23, 21, 21)).toEqual({ legal: true, winner: 'a' });
    expect(judgeSet(15, 13, 15)).toEqual({ legal: true, winner: 'a' });
    expect(judgeSet(16, 18, 15)).toEqual({ legal: true, winner: 'b' });
  });

  it('rejects unfinished, one-point, and over-run sets with specific reasons', () => {
    expect(reason(judgeSet(20, 18, 21))).toContain('not finished');
    expect(reason(judgeSet(21, 20, 21))).toContain('won by 2');
    expect(reason(judgeSet(25, 21, 21))).toContain('cannot happen');
    expect(judgeSet(21, 21, 21)).toMatchObject({ legal: false });
    expect(judgeSet(-1, 21, 21)).toMatchObject({ legal: false });
    expect(judgeSet(21.5, 10, 21)).toMatchObject({ legal: false });
  });
});

describe('judgeMatch', () => {
  it('best-of-1 is exactly one set to 21', () => {
    expect(judgeMatch([{ setNumber: 1, teamAPoints: 21, teamBPoints: 17 }], 1)).toMatchObject({ legal: true, winner: 'a' });
    expect(judgeMatch([{ setNumber: 1, teamAPoints: 15, teamBPoints: 13 }], 1)).toMatchObject({ legal: false });
    expect(
      judgeMatch(
        [
          { setNumber: 1, teamAPoints: 21, teamBPoints: 17 },
          { setNumber: 2, teamAPoints: 21, teamBPoints: 17 },
        ],
        1,
      ),
    ).toMatchObject({ legal: false });
  });

  it('best-of-3 needs two set wins, third set to 15', () => {
    const straight = [
      { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
      { setNumber: 2, teamAPoints: 21, teamBPoints: 12 },
    ];
    expect(judgeMatch(straight, 3)).toMatchObject({ legal: true, winner: 'a', setsWon: { a: 2, b: 0 } });

    const three = [
      { setNumber: 1, teamAPoints: 21, teamBPoints: 18 },
      { setNumber: 2, teamAPoints: 19, teamBPoints: 21 },
      { setNumber: 3, teamAPoints: 15, teamBPoints: 12 },
    ];
    expect(judgeMatch(three, 3)).toMatchObject({ legal: true, winner: 'a' });

    // A deciding set can run past 15 only two points clear; 21–17 cannot happen.
    const thirdOverrun = [...three.slice(0, 2), { setNumber: 3, teamAPoints: 21, teamBPoints: 17 }];
    expect(reason(judgeMatch(thirdOverrun, 3))).toContain('Set 3');
    // ...but a long deuce deciding set is legal.
    const thirdDeuce = [...three.slice(0, 2), { setNumber: 3, teamAPoints: 21, teamBPoints: 19 }];
    expect(judgeMatch(thirdDeuce, 3)).toMatchObject({ legal: true, winner: 'a' });

    const thirdAfterDecided = [...straight, { setNumber: 3, teamAPoints: 15, teamBPoints: 10 }];
    expect(reason(judgeMatch(thirdAfterDecided, 3))).toContain('already decided');

    const split = three.slice(0, 2);
    expect(reason(judgeMatch(split, 3))).toContain('not finished');

    expect(reason(judgeMatch([{ setNumber: 2, teamAPoints: 21, teamBPoints: 18 }], 3))).toContain('numbered in order');
  });

  it('setTarget is 15 only for the deciding set of a best-of-3', () => {
    expect(setTarget(1, 3)).toBe(21);
    expect(setTarget(3, 3)).toBe(15);
    expect(setTarget(1, 1)).toBe(21);
  });
});
