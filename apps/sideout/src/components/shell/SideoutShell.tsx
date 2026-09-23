import type { ReactNode } from 'react';
import { AppShell, ToastProvider } from '@sideout/ui';

import { SkyBand } from '../art/SkyBand';
import { WaveDivider } from '../art/WaveDivider';
import { OfflineStatus } from '../offline/OfflineStatus';
import { ServiceWorkerRegistration } from '../offline/ServiceWorkerRegistration';
import { DemoPill } from './DemoPill';
import { navItemsFor } from './nav';
import { PrimaryRail, PrimaryTabBar } from './PrimaryNav';
import { Wordmark } from './Wordmark';

/**
 * Bottom tab bar on a phone, left rail from 1280px, one content column (spec 6.3), and
 * the offline surface: the service worker registration, the connectivity line above the
 * content and the outbox replay. The organizer's console tab appears only for an
 * organizer session; every console page gates itself again on the server. A session opened
 * through the public demo's account picker carries the "Demo" pill on every screen.
 */
export function SideoutShell({ role, disputes, buildSha, demo, framing, children }: { role: 'player' | 'organizer' | null; disputes: number; buildSha: string; demo: { displayName: string } | null; framing: boolean; children: ReactNode }) {
  const items = navItemsFor(role, disputes, framing);
  return (
    <ToastProvider>
      {/*
       * The header wears the beach: a sky band with the sun held at the right edge whatever
       * the width, and a wave in the colour of the page below as the header's bottom edge
       * instead of a hairline. Both are decorative, hidden from assistive tech, and hold
       * still under reduced motion.
       */}
      <AppShell
        brand={<Wordmark />}
        rail={<PrimaryRail items={items} />}
        tabBar={<PrimaryTabBar items={items} />}
        status={<OfflineStatus />}
        headerArt={
          <div className="so-shell__art">
            <SkyBand variant="header" />
            <WaveDivider fill="base" edge="top" height={14} line />
          </div>
        }
      >
        {children}
      </AppShell>
      {demo === null ? null : <DemoPill displayName={demo.displayName} />}
      <ServiceWorkerRegistration version={buildSha} />
    </ToastProvider>
  );
}
