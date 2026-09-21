import { Baloo_2, Nunito } from 'next/font/google';

/**
 * Sideout's two families, loaded through next/font so they are self-hosted and exposed as
 * the CSS custom properties the beach theme reads (`--font-nunito`, `--font-baloo`).
 *
 * The platform's faces (Instrument Sans and Archivo Expanded, spec 6.2) stay with the
 * platform: the operator console and the ping-pong tenant still load them. Sideout is a
 * tenant skin (`packages/ui/src/styles/beach.css`) and picks its own.
 *
 * Baloo 2 is the display face. It is the rounded, cartoon-adjacent family that still ships
 * tabular figures, and that is the constraint that decided it: standings, set scores,
 * points and money are read in columns, and Fredoka and Lilita One — rounder and more
 * obviously "cartoon" — have proportional digits only, so those columns would not line up.
 *
 * Nunito is the UI face, and is tabular by default.
 */
export const nunito = Nunito({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-nunito',
});

export const baloo = Baloo_2({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-baloo',
});
