/**
 * A small deterministic PRNG (SplitMix32) so a draw with the same `rngSeed` produces the
 * same pools, and the seed script produces byte-identical data on every run. Not for
 * anything security-related: one-time codes, session signatures and ids use `node:crypto`.
 */
export type Rng = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** Fisher–Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Pick one element; throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  /** `length` pseudo-random bytes (the seed script's UUID v7 entropy). */
  bytes(length: number): Uint8Array;
  /** True with probability `p`. */
  chance(p: number): boolean;
};

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const nextU32 = (): number => {
    state = (state + 0x9e37_79b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };

  const next = (): number => nextU32() / 4_294_967_296;

  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`rng.int: invalid range ${min}..${max}`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i];
        const b = out[j];
        if (a === undefined || b === undefined) continue;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('rng.pick: empty list');
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new RangeError('rng.pick: index out of range');
      return item;
    },
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) out[i] = nextU32() & 0xff;
      return out;
    },
    chance(p) {
      return next() < p;
    },
  };
}
