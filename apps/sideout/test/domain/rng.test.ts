import { describe, expect, it } from 'vitest';

import { createRng } from '../../src/domain/rng';

describe('createRng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng(1);
    const b = createRng(1);
    const c = createRng(2);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    const seqC = Array.from({ length: 20 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const x of seqA) expect(x >= 0 && x < 1).toBe(true);
  });

  it('int, pick, shuffle and bytes behave', () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i += 1) {
      const n = rng.int(3, 5);
      expect(n >= 3 && n <= 5 && Number.isInteger(n)).toBe(true);
    }
    expect(() => rng.int(5, 3)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
    expect([1, 2, 3]).toContain(rng.pick([1, 2, 3]));
    const shuffled = rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rng.bytes(16)).toHaveLength(16);
  });
});
