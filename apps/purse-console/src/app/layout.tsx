import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { archivo, instrumentSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Purse console', template: '%s · Purse console' },
  description: 'The Purse operator console.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#08090B',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${archivo.variable}`}>
      <body>{children}</body>
    </html>
  );
}
