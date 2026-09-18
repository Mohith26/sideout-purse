'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from '../../lib/cx';

export type TabItem = { href: string; label: string; exact?: boolean };

/** The tournament tabs, as links so they are shareable and keyboard-native. */
export function TabNav({ items, ariaLabel }: { items: readonly TabItem[]; ariaLabel: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={ariaLabel} className="relative -mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
      {items.map((item) => {
        const active = item.exact === true ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cx('target inline-flex items-center border-b-2 px-3 font-medium whitespace-nowrap transition-colors duration-(--d-micro)', active ? 'border-volt text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary')}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
