import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ConsoleNav, type ConsoleNavItem } from '../../components/organizer/ConsoleNav';
import { organizerPageContext } from '../../server/pages';
import { countDisputedMatches } from '../../server/screens';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: { default: 'Console', template: '%s · Console · Sideout' } };

/**
 * Organizer console shell (spec 5.3, item 6): role-gated here for every page beneath it,
 * with its own dense navigation. The dispute queue is the primary alert: its count sits
 * on the tab. "Purse" is the audit page (`/admin/purse`).
 */
export default async function OrganizerLayout({ children }: { children: ReactNode }) {
  const { app } = await organizerPageContext();
  const disputes = await countDisputedMatches(app.db);
  const items: ConsoleNavItem[] = [
    { href: '/organizer/events', label: 'Events', icon: 'calendar' },
    { href: '/organizer/disputes', label: 'Disputes', icon: 'triangleAlert', badge: disputes },
    { href: '/admin/purse', label: 'Purse', icon: 'shieldCheck' },
  ];
  return (
    <>
      <div className="-mx-gutter -mt-5 border-b border-border-subtle bg-bg-base md:-mt-6">
        <div className="mx-auto flex max-w-content items-center gap-4 px-gutter pt-3">
          <span className="type-label text-text-tertiary">Console</span>
          <ConsoleNav items={items} />
        </div>
      </div>
      <div className="pt-6 md:pt-8">{children}</div>
    </>
  );
}
