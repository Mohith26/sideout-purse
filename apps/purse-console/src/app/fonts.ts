import { Archivo, Instrument_Sans } from 'next/font/google';

/** The two families from spec 6.2, exposed as the custom properties the token layer reads. */
export const instrumentSans = Instrument_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-instrument-sans' });

export const archivo = Archivo({ subsets: ['latin'], display: 'swap', axes: ['wdth'], variable: '--font-archivo' });
