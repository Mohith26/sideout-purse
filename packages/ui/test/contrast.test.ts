import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { WCAG, contrastRatio, parseHex, relativeLuminance } from '../src/contrast';
import { BACKGROUND_TIERS, SEMANTIC_TEXT, TEXT_TIERS, readColorTokens } from './read-tokens';

const TOKENS_CSS = path.resolve(import.meta.dirname, '../src/styles/tokens.css');

describe('contrast arithmetic', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    // Well-known pairing: #767676 on white is the classic 4.54:1 AA boundary grey.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('parses short and long hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('08090B')).toEqual({ r: 8, g: 9, b: 11 });
    expect(() => parseHex('volt')).toThrow(/hex/);
  });
});

describe('section 6.1 tokens meet WCAG AA', () => {
  const tokensPromise = readColorTokens(TOKENS_CSS);

  function token(tokens: Map<string, string>, name: string): string {
    const value = tokens.get(name);
    if (value === undefined) throw new Error(`token --${name} missing from tokens.css`);
    return value;
  }

  it('defines every colour the spec names', async () => {
    const tokens = await tokensPromise;
    for (const name of [
      ...BACKGROUND_TIERS,
      ...TEXT_TIERS,
      ...SEMANTIC_TEXT,
      'border-subtle',
      'border-strong',
      'volt-dim',
      'on-volt',
    ]) {
      expect(tokens.has(name), `--${name}`).toBe(true);
    }
  });

  it('--volt on --bg-base', async () => {
    const tokens = await tokensPromise;
    expect(contrastRatio(token(tokens, 'volt'), token(tokens, 'bg-base'))).toBeGreaterThanOrEqual(WCAG.AA);
  });

  it('--on-volt on --volt', async () => {
    const tokens = await tokensPromise;
    expect(contrastRatio(token(tokens, 'on-volt'), token(tokens, 'volt'))).toBeGreaterThanOrEqual(WCAG.AA);
  });

  it.each(TEXT_TIERS.flatMap((text) => BACKGROUND_TIERS.map((bg) => [text, bg] as const)))(
    '--%s on --%s',
    async (text, bg) => {
      const tokens = await tokensPromise;
      const ratio = contrastRatio(token(tokens, text), token(tokens, bg));
      expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG.AA);
    },
  );

  it.each(SEMANTIC_TEXT.flatMap((text) => BACKGROUND_TIERS.map((bg) => [text, bg] as const)))(
    'semantic --%s used as text on --%s',
    async (text, bg) => {
      const tokens = await tokensPromise;
      const ratio = contrastRatio(token(tokens, text), token(tokens, bg));
      expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG.AA);
    },
  );

  it('records why --text-tertiary departs from the spec value', async () => {
    const tokens = await tokensPromise;
    // The spec's #646C79 fails AA on every surface; the token must not silently revert.
    expect(token(tokens, 'text-tertiary')).not.toBe('#646c79');
    expect(contrastRatio('#646c79', token(tokens, 'bg-overlay'))).toBeLessThan(WCAG.AA);
  });
});
