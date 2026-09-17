import { Archivo, Instrument_Sans } from 'next/font/google';

/**
 * The two families from spec 6.2, loaded through next/font so they are self-hosted and
 * exposed as CSS custom properties the token layer reads (`--font-instrument-sans`,
 * `--font-archivo`).
 *
 * Instrument Sans is the UI face at 400/500/600; it ships as a variable font so a single
 * file covers the range.
 *
 * "Archivo Expanded" is not a separate Google Fonts family. Archivo is a variable font with
 * a `wdth` axis from 62 to 125; requesting the axis here and setting `font-stretch: 125%`
 * on display text (the token layer's `--display-stretch`) is what produces Expanded.
 */
export const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-instrument-sans',
});

export const archivo = Archivo({
  subsets: ['latin'],
  display: 'swap',
  axes: ['wdth'],
  variable: '--font-archivo',
});
