'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The rail's sections. `aria-current` marks the section the path is under; nothing else in the rail changes. */
const GROUPS: Array<{ label: string; items: Array<{ href: string; label: string }> }> = [
  { label: 'Platform', items: [{ href: '/tenants', label: 'Tenants' }, { href: '/webhooks', label: 'Deliveries' }] },
  { label: 'Play', items: [{ href: '/contests', label: 'Contests' }, { href: '/review', label: 'Review queue' }] },
  { label: 'Ledger', items: [{ href: '/ledger', label: 'Explorer' }, { href: '/invariants', label: 'Invariants' }] },
  { label: 'Rules', items: [{ href: '/rulesets', label: 'Rulesets' }, { href: '/rulesets/tester', label: 'Tester' }] },
];

/** Which section a path belongs to: nested tenant pages count for the section they show, not for Tenants. */
export function sectionOf(pathname: string): string {
  if (pathname === '/rulesets/tester') return '/rulesets/tester';
  if (pathname.startsWith('/rulesets')) return '/rulesets';
  if (pathname.startsWith('/invariants')) return '/invariants';
  if (pathname.startsWith('/accounts/') || pathname.startsWith('/entries/') || pathname === '/ledger' || /^\/tenants\/[^/]+\/ledger/.test(pathname)) return '/ledger';
  if (pathname.startsWith('/contests') || /^\/tenants\/[^/]+\/contests\//.test(pathname)) return '/contests';
  if (pathname.startsWith('/review')) return '/review';
  if (pathname.startsWith('/webhooks')) return '/webhooks';
  if (pathname.startsWith('/tenants')) return '/tenants';
  return '';
}

export function Nav() {
  const pathname = usePathname();
  const section = sectionOf(pathname);
  const current = (href: string): boolean => section === href;
  return (
    <nav className="console__nav" aria-label="Console sections">
      {GROUPS.map((group) => (
        <div key={group.label} className="console__nav" role="group" aria-label={group.label}>
          <span className="label console__nav-group">{group.label}</span>
          {group.items.map((item) => (
            <Link key={item.href} href={item.href} aria-current={current(item.href) ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
