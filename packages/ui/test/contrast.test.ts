import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { WCAG, contrastRatio, parseHex, relativeLuminance } from '../src/contrast';
import { BACKGROUND_TIERS, SEMANTIC_TEXT, TEXT_TIERS, readColorTokens } from './read-tokens';

const TOKENS_CSS = path.resolve(import.meta.dirname, '../src/styles/tokens.css');
/** Sideout's tenant skin, held to the same contrast rules as the platform theme. */
const BEACH_CSS = path.resolve(import.meta.dirname, '../src/styles/beach.css');

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

/**
 * Sideout's cartoon beach theme (`beach.css`) redefines the same tokens with a light
 * palette, so it carries the same obligations and is held to them here rather than trusted
 * to be pretty. A skin is where contrast is most likely to be lost: the temptation is a
 * light, friendly coral on sand, which a person cannot read.
 */
describe('the beach theme meets WCAG AA', () => {
  const beachPromise = readColorTokens(BEACH_CSS);

  function token(tokens: Map<string, string>, name: string): string {
    const value = tokens.get(name);
    if (value === undefined) throw new Error(`token --${name} missing from beach.css`);
    return value;
  }

  it('redefines every colour the platform theme defines, so no screen falls back to a dark token', async () => {
    const [beach, platform] = await Promise.all([beachPromise, readColorTokens(TOKENS_CSS)]);
    for (const name of [
      ...BACKGROUND_TIERS,
      ...TEXT_TIERS,
      ...SEMANTIC_TEXT,
      'border-subtle',
      'border-strong',
      'volt-dim',
      'on-volt',
    ]) {
      expect(platform.has(name), `platform --${name}`).toBe(true);
      expect(beach.has(name), `beach --${name}`).toBe(true);
    }
  });

  it('is a light theme: every surface is lighter than every ink', async () => {
    const tokens = await beachPromise;
    for (const bg of BACKGROUND_TIERS) {
      for (const text of TEXT_TIERS) {
        expect(relativeLuminance(token(tokens, bg)), `--${bg} vs --${text}`).toBeGreaterThan(relativeLuminance(token(tokens, text)));
      }
    }
  });

  it('--on-volt on --volt', async () => {
    const tokens = await beachPromise;
    expect(contrastRatio(token(tokens, 'on-volt'), token(tokens, 'volt'))).toBeGreaterThanOrEqual(WCAG.AA);
  });

  it.each(TEXT_TIERS.flatMap((text) => BACKGROUND_TIERS.map((bg) => [text, bg] as const)))(
    'beach --%s on --%s',
    async (text, bg) => {
      const tokens = await beachPromise;
      const ratio = contrastRatio(token(tokens, text), token(tokens, bg));
      expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG.AA);
    },
  );

  it.each(SEMANTIC_TEXT.flatMap((text) => BACKGROUND_TIERS.map((bg) => [text, bg] as const)))(
    'beach semantic --%s used as text on --%s',
    async (text, bg) => {
      const tokens = await beachPromise;
      const ratio = contrastRatio(token(tokens, text), token(tokens, bg));
      expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG.AA);
    },
  );

  it('defines the illustration colours, and keeps them out of the text and surface roles', async () => {
    const tokens = await beachPromise;
    const art = ['art-sky', 'art-ocean', 'art-palm', 'art-sun', 'art-sand'];
    for (const name of art) expect(tokens.has(name), `--${name}`).toBe(true);
    // Art colours are for the SVGs only; none of them may double as a text or surface token,
    // because nothing checks their contrast.
    const roles = [...TEXT_TIERS, ...BACKGROUND_TIERS, ...SEMANTIC_TEXT].map((r) => token(tokens, r));
    for (const name of art) expect(roles, `--${name}`).not.toContain(token(tokens, name));
  });
});
