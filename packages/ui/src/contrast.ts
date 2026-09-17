/**
 * WCAG 2.x contrast arithmetic, used by the token test and available to any consumer that
 * needs to prove a colour pairing at runtime (the embed's partner theming in phase 4).
 */

export type Rgb = { r: number; g: number; b: number };

/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` (alpha ignored) into 0–255 channels. */
export function parseHex(hex: string): Rgb {
  const clean = hex.trim().replace(/^#/, '');
  const full =
    clean.length === 3 || clean.length === 4
      ? clean
          .slice(0, 3)
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${JSON.stringify(hex)}`);
  }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.x, 0 (black) to 1 (white). */
export function relativeLuminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === 'string' ? parseHex(color) : color;
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** Contrast ratio between two colours, 1 to 21, order independent. */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG 2.x thresholds. */
export const WCAG = {
  /** AA, normal text. */
  AA: 4.5,
  /** AA, large text (≥ 24px, or ≥ 18.66px bold) and UI components. */
  AA_LARGE: 3,
  AAA: 7,
} as const;

export function meetsAA(foreground: Rgb | string, background: Rgb | string, large = false): boolean {
  return contrastRatio(foreground, background) >= (large ? WCAG.AA_LARGE : WCAG.AA);
}
