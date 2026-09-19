import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell } from '@sideout/ui';

import { buildSha } from '../build-info';
import { env } from '../env';
import { HeaderNav } from '../components/HeaderNav';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Ping-pong', template: '%s · Ping-pong' },
  description: 'The office table-tennis ladder: challenge up, confirm results, and settle the season on Purse.',
  applicationName: 'Ping-pong',
};

export const viewport: Viewport = { themeColor: '#08090B', colorScheme: 'dark', width: 'device-width', initialScale: 1 };

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  const sha = buildSha(env().buildSha);
  return (
    <html lang="en">
      <body>
        <AppShell brand={<Link href="/" className="so-shell__brand type-heading">Ping-pong</Link>} nav={<HeaderNav />} footer={<span className="type-label">The second tenant on Purse · build {sha.slice(0, 7)}</span>}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
