import type { IconName } from '@sideout/ui';

export type PrimaryNavItem = { href: string; label: string; icon: IconName; badge?: number };

/** Primary navigation for everyone. */
export const NAV_ITEMS: readonly PrimaryNavItem[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/events', label: 'Events', icon: 'calendar' },
  { href: '/impact', label: 'Impact', icon: 'heartHandshake' },
  { href: '/me', label: 'Me', icon: 'user' },
];

/** Added for an organizer session: the console is role-gated on the server, so the link is only shown to those who can open it. */
export function navItemsFor(role: 'player' | 'organizer' | null, disputes = 0): PrimaryNavItem[] {
  return role === 'organizer' ? [...NAV_ITEMS, { href: '/organizer', label: 'Console', icon: 'console', badge: disputes }] : [...NAV_ITEMS];
}

export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/t/') || pathname.startsWith('/m/');
  if (href === '/me') return pathname === href || pathname.startsWith(`${href}/`) || pathname.startsWith('/teams/') || pathname === '/sign-in';
  if (href === '/organizer') return pathname.startsWith('/organizer') || pathname.startsWith('/admin');
  return pathname === href || pathname.startsWith(`${href}/`);
}
