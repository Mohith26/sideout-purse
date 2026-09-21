/**
 * The one flat-vector style every illustration under src/components/art shares:
 * ink outlines on the text colour, fills on the five `--art-*` tokens from
 * tokens.css (sky, ocean, palm, sun, sand) plus the surfaces, no gradients, no
 * photos. The tokens are read through `var()` so the art re-colours with the
 * theme and never hardcodes a hex.
 *
 * Every piece is decorative: it renders `aria-hidden` and `focusable="false"`,
 * and nothing it shows is data. Illustrations frame, divide and decorate around
 * the tables, the sheet and the bracket; they never sit under them.
 */
export const INK = "var(--text-primary)";
export const SKY = "var(--art-sky)";
export const OCEAN = "var(--art-ocean)";
export const PALM = "var(--art-palm)";
export const SUN = "var(--art-sun)";
export const SAND = "var(--art-sand)";
export const CREAM = "var(--bg-raised)";
export const WHITE = "var(--bg-overlay)";
export const FOAM = "var(--bg-inset)";
export const BASE = "var(--bg-base)";
export const SURF = "var(--surf)";

/** Outline weight: 2px on a piece that stands alone, 1.5px inside a scene. */
export const STROKE = 2;
export const STROKE_FINE = 1.5;

/** Shared attributes for a decorative `<svg>`. */
export const DECORATIVE = { "aria-hidden": true, focusable: "false", role: "presentation" } as const;
