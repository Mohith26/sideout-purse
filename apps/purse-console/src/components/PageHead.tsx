import Link from 'next/link';
import type { ReactNode } from 'react';

export type Crumb = { label: string; href?: string };

export function PageHead({ title, crumbs = [], lede, actions }: { title: string; crumbs?: Crumb[]; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      {crumbs.length === 0 ? null : (
        <nav className="console__crumbs" aria-label="Breadcrumb">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`}>
              {crumb.href === undefined ? crumb.label : <Link href={crumb.href}>{crumb.label}</Link>}
              {index < crumbs.length - 1 ? <span aria-hidden="true"> / </span> : null}
            </span>
          ))}
        </nav>
      )}
      <div className="console__head">
        <h1 className="console__title">{title}</h1>
        {actions === undefined ? null : <div className="so-actions">{actions}</div>}
      </div>
      {lede === undefined ? null : <p className="console__lede">{lede}</p>}
    </div>
  );
}
