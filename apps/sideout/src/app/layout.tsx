import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell } from '@sideout/ui';

import { archivo, instrumentSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sideout', template: '%s · Sideout' },
  description: 'Charity beach volleyball tournaments.',
  applicationName: 'Sideout',
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
      <body>
        <AppShell
          brand={
            <Link href="/" className="so-shell__brand display" aria-label="Sideout home">
              Sideout
            </Link>
          }
          footer={
            <>
              <span>Sideout runs on Purse.</span>
              <span>Charity beach volleyball. Closed-loop points, real donations.</span>
            </>
          }
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
