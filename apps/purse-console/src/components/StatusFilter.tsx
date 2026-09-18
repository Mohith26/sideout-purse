import Link from 'next/link';

import { titleCase } from '../lib/format';

/** A row of links, one per status plus "all"; the current one is marked. Server-rendered, so a filter is a URL. */
export function StatusFilter({ options, current, basePath, param = 'status', extra = {} }: { options: readonly string[]; current: string | undefined; basePath: string; param?: string; extra?: Record<string, string> }) {
  const href = (value: string | undefined): string => {
    const query = new URLSearchParams(extra);
    if (value !== undefined) query.set(param, value);
    const text = query.toString();
    return text === '' ? basePath : `${basePath}?${text}`;
  };
  return (
    <nav className="so-actions" aria-label="Filter">
      <Link href={href(undefined)} className={`so-chip${current === undefined ? ' so-chip--current' : ''}`} aria-current={current === undefined ? 'true' : undefined}>
        all
      </Link>
      {options.map((option) => (
        <Link key={option} href={href(option)} className={`so-chip${current === option ? ' so-chip--current' : ''}`} aria-current={current === option ? 'true' : undefined}>
          {titleCase(option)}
        </Link>
      ))}
    </nav>
  );
}
