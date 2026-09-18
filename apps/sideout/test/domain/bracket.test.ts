import { describe, expect, it } from 'vitest';

import { advanceWinner, BracketError, forfeitWinner } from '../../src/domain/bracket';
import { drawBracket } from '../../src/domain/draw';

describe('advanceWinner', () => {
  const seeds = Array.from({ length: 6 }, (_, i) => ({ teamId: `t${i + 1}`, seed: i + 1 }));
  const draw = drawBracket({ seeds, courts: 2, bestOf: 3 });
  const link = (position: number) => {
    const m = draw.matches.find((x) => x.position === position);
    if (m === undefined) throw new Error('missing');
    return {
      id: `m${m.position}`,
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      teamASeed: m.teamASeed,
      teamBSeed: m.teamBSeed,
      nextMatchId: m.nextPosition === null ? null : `m${m.nextPosition}`,
      nextMatchSlot: m.nextSlot,
    };
  };

  it('lands the winner in the slot the draw linked', () => {
    // Bracket of 8 from 6 teams: positions 1..4 are round 1 (1 and 3 are byes for seeds 1 and 2... by placement).
    const played = draw.matches.filter((m) => m.round === 1 && !m.isBye);
    for (const m of played) {
      const winner = m.teamAId ?? '';
      const result = advanceWinner(link(m.position), winner);
      expect(result).toEqual({ fromMatchId: `m${m.position}`, nextMatchId: `m${m.nextPosition}`, slot: m.nextSlot, teamId: winner, seed: m.teamASeed });
    }
  });

  it('returns null from the final', () => {
    const final = draw.matches.find((m) => m.round === draw.rounds);
    const finalLink = { ...link(final?.position ?? 0), teamAId: 't1', teamBId: 't2' };
    expect(advanceWinner(finalLink, 't2')).toBeNull();
  });

  it('refuses a winner who is not playing and a malformed link', () => {
    const played = draw.matches.find((m) => m.round === 1 && !m.isBye);
    expect(() => advanceWinner(link(played?.position ?? 0), 'stranger')).toThrow(BracketError);
    expect(() => advanceWinner({ id: 'm', teamAId: 'x', teamBId: 'y', nextMatchId: 'n', nextMatchSlot: null }, 'x')).toThrow(/without a slot/);
  });

  it('a forfeit awards the other team', () => {
    expect(forfeitWinner({ id: 'm', teamAId: 'x', teamBId: 'y' }, 'x')).toBe('y');
    expect(forfeitWinner({ id: 'm', teamAId: 'x', teamBId: 'y' }, 'y')).toBe('x');
    expect(() => forfeitWinner({ id: 'm', teamAId: 'x', teamBId: null }, 'x')).toThrow(BracketError);
    expect(() => forfeitWinner({ id: 'm', teamAId: 'x', teamBId: 'y' }, 'z')).toThrow(BracketError);
  });
});
