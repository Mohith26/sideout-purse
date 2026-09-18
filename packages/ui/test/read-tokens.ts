import { readFile } from 'node:fs/promises';

/**
 * Read the colour tokens back out of tokens.css. The CSS file is the one definition; this
 * parser exists so tests and tooling can reason about the same values without a second
 * copy that could drift.
 */
export async function readColorTokens(tokensCssPath: string): Promise<Map<string, string>> {
  const css = await readFile(tokensCssPath, 'utf8');
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens.set(name, value.toLowerCase());
  }
  return tokens;
}

/** Text tiers and the surfaces they may sit on; the contrast test crosses them. */
export const TEXT_TIERS = ['text-primary', 'text-secondary', 'text-tertiary'] as const;
export const BACKGROUND_TIERS = ['bg-base', 'bg-raised', 'bg-overlay', 'bg-inset'] as const;
/** Semantic colours that are used as text (pill labels, deltas, errors). */
export const SEMANTIC_TEXT = ['volt', 'surf', 'ember', 'fault'] as const;
