'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavRail, TabBar, type NavItem } from '@sideout/ui';

import { isActivePath, type PrimaryNavItem } from './nav';
import { Wordmark } from './Wordmark';

/** The tab bar below 1280px and the rail above it, both from one item list, the active item from the pathname. */
function withActive(items: readonly PrimaryNavItem[], pathname: string): NavItem[] {
  return items.map((item) => ({ ...item, active: isActivePath(pathname, item.href) }));
}

export function PrimaryTabBar({ items }: { items: readonly PrimaryNavItem[] }) {
  const pathname = usePathname();
  return <TabBar items={withActive(items, pathname)} component={Link} />;
}

export function PrimaryRail({ items }: { items: readonly PrimaryNavItem[] }) {
  const pathname = usePathname();
  return <NavRail items={withActive(items, pathname)} component={Link} brand={<Wordmark />} foot="Charity beach volleyball" />;
}
