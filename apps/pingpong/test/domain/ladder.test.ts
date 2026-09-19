import { describe, expect, it } from 'vitest';

import { applyResult, assertGapless, CHALLENGE_REACH, finalScore, finalScores, judgeChallenge, judgeScoreline, nameKeyOf, runningScore, type LadderEntry } from '../../src/domain/ladder';

/** The ladder rules as a case table (docs/second-tenant.md). */
const ladder = (...ids: string[]): LadderEntry[] => ids.map((playerId, index) => ({ playerId, rank: index + 1, wins: 0, losses: 0 }));

describe('judgeChallenge', () => {
  const five = ladder('a', 'b', 'c', 'd', 'e');

  it('lets a player challenge anyone up to three places above', () => {
    expect(judgeChallenge(five, 'e', 'd', [])).toEqual({ ok: true });
    expect(judgeChallenge(five, 'e', 'b', [])).toEqual({ ok: true });
    expect(CHALLENGE_REACH).toBe(3);
  });

  it('refuses a challenge more than three places up', () => {
    expect(judgeChallenge(five, 'e', 'a', [])).toMatchObject({ ok: false, reason: 'out_of_reach' });
  });

  it('refuses challenging down, yourself, or someone not on the ladder', () => {
    expect(judgeChallenge(five, 'a', 'b', [])).toMatchObject({ ok: false, reason: 'not_above' });
    expect(judgeChallenge(five, 'c', 'c', [])).toMatchObject({ ok: false, reason: 'self' });
    expect(judgeChallenge(five, 'c', 'zed', [])).toMatchObject({ ok: false, reason: 'not_on_ladder' });
    expect(judgeChallenge(five, 'zed', 'c', [])).toMatchObject({ ok: false, reason: 'not_on_ladder' });
  });

  it('refuses while either side has an open match', () => {
    expect(judgeChallenge(five, 'e', 'd', [{ challengerId: 'e', defenderId: 'c' }])).toMatchObject({ ok: false, reason: 'busy', message: expect.stringMatching(/^You already have/) as string });
    expect(judgeChallenge(five, 'e', 'd', [{ challengerId: 'c', defenderId: 'd' }])).toMatchObject({ ok: false, reason: 'busy', message: expect.stringMatching(/^They already have/) as string });
    expect(judgeChallenge(five, 'e', 'd', [{ challengerId: 'b', defenderId: 'a' }])).toEqual({ ok: true });
  });
});

describe('judgeScoreline', () => {
  it('accepts a game to 11 won by two and names the winner', () => {
    expect(judgeScoreline({ challenger: 11, defender: 7 })).toEqual({ ok: true, winner: 'challenger' });
    expect(judgeScoreline({ challenger: 9, defender: 11 })).toEqual({ ok: true, winner: 'defender' });
    expect(judgeScoreline({ challenger: 15, defender: 13 })).toEqual({ ok: true, winner: 'challenger' });
  });

  it('refuses a level game, a short game, a one-point margin, and an overrun deuce', () => {
    expect(judgeScoreline({ challenger: 11, defender: 11 })).toMatchObject({ ok: false });
    expect(judgeScoreline({ challenger: 10, defender: 8 })).toMatchObject({ ok: false });
    expect(judgeScoreline({ challenger: 11, defender: 10 })).toMatchObject({ ok: false });
    expect(judgeScoreline({ challenger: 15, defender: 11 })).toMatchObject({ ok: false });
    expect(judgeScoreline({ challenger: 11.5, defender: 3 })).toMatchObject({ ok: false });
    expect(judgeScoreline({ challenger: -1, defender: 11 })).toMatchObject({ ok: false });
    expect(judgeScoreline({ challenger: 120, defender: 118 })).toMatchObject({ ok: false });
  });
});

describe('applyResult', () => {
  const five = ladder('a', 'b', 'c', 'd', 'e');

  it('moves a winning challenger into the defender’s place and everyone between down one', () => {
    const { ladder: after, moved, winnerId, loserId } = applyResult(five, { challengerId: 'e', defenderId: 'b', winner: 'challenger' });
    expect(moved).toBe(true);
    expect(winnerId).toBe('e');
    expect(loserId).toBe('b');
    expect(after.map((r) => r.playerId)).toEqual(['a', 'e', 'b', 'c', 'd']);
    expect(after.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(after.find((r) => r.playerId === 'e')).toMatchObject({ wins: 1, losses: 0 });
    expect(after.find((r) => r.playerId === 'b')).toMatchObject({ wins: 0, losses: 1 });
    expect(after.find((r) => r.playerId === 'c')).toMatchObject({ wins: 0, losses: 0 });
    assertGapless(after);
  });

  it('moves nobody when the defender wins, but the records still count', () => {
    const { ladder: after, moved } = applyResult(five, { challengerId: 'e', defenderId: 'b', winner: 'defender' });
    expect(moved).toBe(false);
    expect(after.map((r) => r.playerId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(after.find((r) => r.playerId === 'b')).toMatchObject({ wins: 1, losses: 0 });
    expect(after.find((r) => r.playerId === 'e')).toMatchObject({ wins: 0, losses: 1 });
  });

  it('swaps adjacent players cleanly and leaves the input alone', () => {
    const { ladder: after } = applyResult(five, { challengerId: 'b', defenderId: 'a', winner: 'challenger' });
    expect(after.map((r) => r.playerId)).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(five.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a result between players the wrong way round or off the ladder', () => {
    expect(() => applyResult(five, { challengerId: 'a', defenderId: 'b', winner: 'challenger' })).toThrow(RangeError);
    expect(() => applyResult(five, { challengerId: 'zed', defenderId: 'b', winner: 'challenger' })).toThrow(RangeError);
  });
});

describe('what the ladder tells Purse', () => {
  it('running scores are wins; final scores are the rank upside down, strictly decreasing', () => {
    expect(runningScore(3)).toBe(3);
    expect(() => runningScore(-1)).toThrow(RangeError);
    expect([1, 2, 3, 4].map((rank) => finalScore(rank, 4))).toEqual([4, 3, 2, 1]);
    expect(() => finalScore(5, 4)).toThrow(RangeError);
    const scores = finalScores(ladder('a', 'b', 'c'));
    expect([...scores.entries()]).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
  });

  it('refuses a ladder with a gap', () => {
    expect(() => finalScores([{ playerId: 'a', rank: 1, wins: 0, losses: 0 }, { playerId: 'b', rank: 3, wins: 0, losses: 0 }])).toThrow(/not 1\.\.2/);
  });
});

describe('nameKeyOf', () => {
  it('normalises spelling, accents and spacing to one key per person', () => {
    expect(nameKeyOf('Ada')).toBe('ada');
    expect(nameKeyOf('  ada  LOVELACE ')).toBe('ada-lovelace');
    expect(nameKeyOf('Zoë')).toBe('zoe');
    expect(nameKeyOf('!!!')).toBeNull();
  });
});
