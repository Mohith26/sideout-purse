import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every named transition in motion.css (spec 6.3) has a branch under
 * `prefers-reduced-motion: reduce` that keeps only opacity. This parses the stylesheet: the
 * keyframes declared outside the query must each be redefined inside it, and the
 * redefinition may declare nothing but opacity.
 */
const css = readFileSync(path.resolve(import.meta.dirname, '../src/styles/motion.css'), 'utf8');
const tokens = readFileSync(path.resolve(import.meta.dirname, '../src/styles/tokens.css'), 'utf8');

const REDUCED = '@media (prefers-reduced-motion: reduce)';

/** The body of the first reduced-motion block, by brace matching. */
function reducedBlock(source: string): string {
  const start = source.indexOf(REDUCED);
  expect(start, 'a reduced-motion block').toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced media block');
}

function keyframes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
    }
    out.set(match[1] ?? '', source.slice(re.lastIndex, i - 1));
  }
  return out;
}

function declaredProperties(body: string): string[] {
  return [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1] ?? '').filter((p) => p !== '');
}

const NAMED = {
  'score count-up': 'score-settle',
  'standings reorder': 'rank-flash',
  'bracket advancement': 'draw-path',
  'consensus confirm': 'confirm-check',
  sheet: 'sheet-in',
  'sheet exit': 'sheet-out',
  'sheet backdrop': 'backdrop-in',
  'live pulse': 'live-pulse',
} as const;

describe('motion.css', () => {
  const reduced = reducedBlock(css);
  const full = keyframes(css.slice(0, css.indexOf(REDUCED)));
  const reducedFrames = keyframes(reduced);

  it("declares every named transition's keyframes on the motion tokens", () => {
    for (const name of Object.values(NAMED)) expect(full.has(name), `@keyframes ${name}`).toBe(true);
    for (const token of ['--d-base', '--d-enter', '--d-draw', '--ease-out-expo', '--ease-in-out-quart']) expect(css).toContain(`var(${token})`);
    expect(css).toMatch(/live-pulse 2s/);
    // The sheet backdrop is the one blur in the system (spec 7).
    expect(css).toMatch(/backdrop-filter: blur\(8px\)/);
  });

  it.each(Object.entries(NAMED))('%s (%s) collapses to opacity only under reduced motion', (_label, name) => {
    const body = reducedFrames.get(name);
    expect(body, `reduced @keyframes ${name}`).toBeDefined();
    expect([...new Set(declaredProperties(body ?? ''))]).toEqual(['opacity']);
  });

  it('the full keyframes really do move, so the reduced branch is a change and not a copy', () => {
    for (const name of ['rank-flash', 'draw-path', 'confirm-check', 'sheet-in', 'sheet-out', 'live-pulse']) {
      const properties = declaredProperties(full.get(name) ?? '');
      expect(properties.some((p) => p !== 'opacity'), `${name} animates more than opacity outside reduced motion`).toBe(true);
    }
  });

  it('holds the live dot still and drops the dash on the path under reduced motion', () => {
    expect(reduced).toMatch(/\.live-dot\s*\{\s*animation:\s*none;/);
    expect(reduced).toMatch(/\.path-draw\s*\{\s*stroke-dasharray:\s*none;/);
  });

  it('the token layer keeps transitions opacity-only and never lets an animation loop under reduced motion', () => {
    const block = reducedBlock(tokens);
    expect(block).toContain('transition-property: opacity !important');
    expect(block).toContain('animation-iteration-count: 1 !important');
  });
});
