// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { flipKeyframes, flipMoves, playFlip, rankDelta, snapshotRows, type FlipSnapshot } from '../../src/components/motion/flip';

/** The ~40-line FLIP helper (spec 6.3, transition 2): first, last, invert, play, and the surf flash on a rank change. */
function rect(top: number, rank: string | null = null) {
  return { top, left: 0, rank };
}

function row(teamId: string, rank: number, top: number): HTMLElement {
  const tr = document.createElement('tr');
  tr.dataset['teamId'] = teamId;
  tr.dataset['rank'] = String(rank);
  const slot = document.createElement('span');
  slot.dataset['rankDeltaSlot'] = '';
  tr.appendChild(slot);
  tr.getBoundingClientRect = () => ({ top, left: 0, width: 300, height: 40, right: 300, bottom: top + 40, x: 0, y: top, toJSON: () => ({}) });
  return tr;
}

describe('flip helper', () => {
  it('snapshots rows by key with their rank', () => {
    const snap = snapshotRows([row('a', 1, 0), row('b', 2, 40)], (el) => el.dataset['teamId'] ?? null);
    expect(snap.get('a')).toEqual(rect(0, '1'));
    expect(snap.get('b')).toEqual(rect(40, '2'));
  });

  it('reports only rows that moved or changed rank, and ignores rows with no first position', () => {
    const before: FlipSnapshot = new Map([
      ['a', rect(0, '1')],
      ['b', rect(40, '2')],
      ['c', rect(80, '3')],
    ]);
    const after: FlipSnapshot = new Map([
      ['b', rect(0, '1')],
      ['a', rect(40, '2')],
      ['c', rect(80, '3')],
      ['d', rect(120, '4')],
    ]);
    expect(flipMoves(before, after)).toEqual([
      { key: 'b', dx: 0, dy: 40, rankFrom: '2', rankTo: '1' },
      { key: 'a', dx: 0, dy: -40, rankFrom: '1', rankTo: '2' },
    ]);
  });

  it('counts a rank change without movement as a move, so the flash still fires', () => {
    const before: FlipSnapshot = new Map([['a', rect(0, '2')]]);
    const after: FlipSnapshot = new Map([['a', rect(0, '1')]]);
    expect(flipMoves(before, after)).toEqual([{ key: 'a', dx: 0, dy: 0, rankFrom: '2', rankTo: '1' }]);
    expect(rankDelta({ rankFrom: '2', rankTo: '1' })).toBe(1);
    expect(rankDelta({ rankFrom: '1', rankTo: '3' })).toBe(-2);
    expect(rankDelta({ rankFrom: null, rankTo: '3' })).toBe(0);
  });

  it('slides with a transform normally and cross-fades with opacity only under reduced motion', () => {
    expect(flipKeyframes({ dx: 0, dy: 40 }, false)).toEqual([{ transform: 'translate(0px, 40px)' }, { transform: 'none' }]);
    const reduced = flipKeyframes({ dx: 0, dy: 40 }, true);
    for (const frame of reduced) expect(Object.keys(frame)).toEqual(['opacity']);
  });

  it('plays each move with the Web Animations API on the motion tokens and flashes a changed rank', () => {
    const a = row('a', 2, 40);
    const b = row('b', 1, 0);
    const animate = vi.fn();
    a.animate = animate;
    b.animate = animate;
    playFlip(
      new Map([
        ['a', a],
        ['b', b],
      ]),
      [
        { key: 'a', dx: 0, dy: -40, rankFrom: '1', rankTo: '2' },
        { key: 'b', dx: 0, dy: 40, rankFrom: '2', rankTo: '1' },
      ],
      { durationMs: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', reducedMotion: false },
    );
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[0]?.[1]).toEqual({ duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    expect(b.classList.contains('rank-flash')).toBe(true);
    expect(b.dataset['rankDelta']).toBe('+1');
    expect(b.querySelector('[data-rank-delta-slot]')?.textContent).toBe('↑1');
    expect(a.dataset['rankDelta']).toBe('-1');
    expect(a.querySelector('[data-rank-delta-slot]')?.textContent).toBe('↓1');
    // The flash is a single beat: it clears itself when the animation ends.
    b.dispatchEvent(new Event('animationend'));
    expect(b.classList.contains('rank-flash')).toBe(false);
    expect(b.dataset['rankDelta']).toBeUndefined();
    expect(b.querySelector('[data-rank-delta-slot]')?.textContent).toBe('');
  });

  it('does not animate a row that only changed rank, and survives an element without animate()', () => {
    const a = row('a', 1, 0);
    const animate = vi.fn();
    a.animate = animate;
    playFlip(new Map([['a', a]]), [{ key: 'a', dx: 0, dy: 0, rankFrom: '2', rankTo: '1' }], { durationMs: 220, easing: 'linear', reducedMotion: false });
    expect(animate).not.toHaveBeenCalled();
    expect(a.classList.contains('rank-flash')).toBe(true);
    const bare = row('b', 1, 0);
    Object.defineProperty(bare, 'animate', { value: undefined });
    expect(() => playFlip(new Map([['b', bare]]), [{ key: 'b', dx: 0, dy: 40, rankFrom: '1', rankTo: '1' }], { durationMs: 220, easing: 'linear', reducedMotion: true })).not.toThrow();
  });

  it('is about forty lines of logic, as the spec asks', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(path.resolve(import.meta.dirname, '../../src/components/motion/flip.ts'), 'utf8');
    const code = source.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('*') && !line.trim().startsWith('/**') && !line.trim().startsWith('//') && !line.trim().startsWith('*/'));
    expect(code.length).toBeGreaterThan(30);
    expect(code.length).toBeLessThanOrEqual(55);
  });
});
