import type { IconName } from '@sideout/ui';

export type PrimaryNavItem = { href: string; label: string; icon: IconName; badge?: number };

/** Primary navigation for everyone. `Money` is the treasury walkthrough (spec section 13). */
export const NAV_ITEMS: readonly PrimaryNavItem[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/events', label: 'Events', icon: 'calendar' },
  { href: '/money', label: 'Money', icon: 'wallet' },
  { href: '/impact', label: 'Impact', icon: 'heartHandshake' },
  { href: '/me', label: 'Me', icon: 'user' },
];

/**
 * The navigation for a session. The console link is added for an organizer (the console is
 * role-gated on the server, so the link is only shown to those who can open it), and the
 * partner-framing page only when `LUCRA_FRAMING` is on.
 */
export function navItemsFor(role: 'player' | 'organizer' | null, disputes = 0, framing = false): PrimaryNavItem[] {
  const items = [...NAV_ITEMS];
  if (framing) items.push({ href: '/lucra', label: 'Why', icon: 'info' });
  if (role === 'organizer') items.push({ href: '/organizer', label: 'Console', icon: 'console', badge: disputes });
  return items;
}

export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/t/') || pathname.startsWith('/m/');
  if (href === '/me') return pathname === href || pathname.startsWith(`${href}/`) || pathname.startsWith('/teams/') || pathname === '/sign-in';
  if (href === '/organizer') return pathname.startsWith('/organizer') || pathname.startsWith('/admin');
  return pathname === href || pathname.startsWith(`${href}/`);
}
