'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavRail, TabBar, type NavItem } from '@sideout/ui';

import { SkyBand } from '../art/SkyBand';
import { WaveDivider } from '../art/WaveDivider';
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

/**
 * The desktop rail. It carries the same sky and wave the header does, because from 1280px
 * the header is hidden and the rail is the only chrome on the screen: without this the
 * beach would disappear on a laptop.
 */
export function PrimaryRail({ items }: { items: readonly PrimaryNavItem[] }) {
  const pathname = usePathname();
  return (
    <NavRail
      items={withActive(items, pathname)}
      component={Link}
      brand={<Wordmark />}
      brandArt={
        <div>
          <SkyBand variant="rail" />
          <WaveDivider fill="base" edge="top" height={12} line />
        </div>
      }
      foot="Charity beach volleyball"
    />
  );
}
