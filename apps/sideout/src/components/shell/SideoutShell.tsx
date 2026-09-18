import type { ReactNode } from 'react';
import { AppShell, ToastProvider } from '@sideout/ui';

import { OfflineStatus } from '../offline/OfflineStatus';
import { ServiceWorkerRegistration } from '../offline/ServiceWorkerRegistration';
import { navItemsFor } from './nav';
import { PrimaryRail, PrimaryTabBar } from './PrimaryNav';
import { Wordmark } from './Wordmark';

/**
 * Bottom tab bar on a phone, left rail from 1280px, one content column (spec 6.3), and
 * the offline surface: the service worker registration, the connectivity line above the
 * content and the outbox replay. The organizer's console tab appears only for an
 * organizer session; every console page gates itself again on the server.
 */
export function SideoutShell({ role, disputes, buildSha, children }: { role: 'player' | 'organizer' | null; disputes: number; buildSha: string; children: ReactNode }) {
  const items = navItemsFor(role, disputes);
  return (
    <ToastProvider>
      <AppShell brand={<Wordmark />} rail={<PrimaryRail items={items} />} tabBar={<PrimaryTabBar items={items} />} status={<OfflineStatus />}>
        {children}
      </AppShell>
      <ServiceWorkerRegistration version={buildSha} />
    </ToastProvider>
  );
}
