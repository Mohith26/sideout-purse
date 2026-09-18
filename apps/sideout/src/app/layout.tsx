import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { SideoutShell } from '../components/shell/SideoutShell';
import { buildSha } from '../build-info';
import { pageContext } from '../server/pages';
import { countDisputedMatches } from '../server/screens';
import { archivo, instrumentSans } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sideout', template: '%s · Sideout' },
  description: 'Charity beach volleyball tournaments: live play, standings, and what every event raises.',
  applicationName: 'Sideout',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Sideout', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#08090B',
  colorScheme: 'dark',
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
};

// The shell reads the session on every request; nothing here is cached at build.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { app, user } = await pageContext();
  const role = user?.role ?? null;
  const disputes = role === 'organizer' ? await countDisputedMatches(app.db) : 0;
  return (
    <html lang="en" className={`${instrumentSans.variable} ${archivo.variable}`}>
      <body>
        <SideoutShell role={role} disputes={disputes} buildSha={buildSha(app.env.buildSha)}>
          {children}
        </SideoutShell>
      </body>
    </html>
  );
}
