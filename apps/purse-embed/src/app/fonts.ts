import { Archivo, Instrument_Sans } from 'next/font/google';

/**
 * The two families from spec 6.2, self-hosted through next/font and exposed as the
 * custom properties the token layer reads (`--font-instrument-sans`, `--font-archivo`),
 * exactly as Sideout loads them, so a Purse flow inside a Sideout page uses the same
 * faces the page around it does.
 */
export const instrumentSans = Instrument_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-instrument-sans' });

export const archivo = Archivo({ subsets: ['latin'], display: 'swap', axes: ['wdth'], variable: '--font-archivo' });
