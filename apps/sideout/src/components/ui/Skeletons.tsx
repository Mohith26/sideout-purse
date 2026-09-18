import { Skeleton } from '@sideout/ui';

import { cx } from '../../lib/cx';

/**
 * Loading placeholders that match the shape of what loads. Screens use these shapes in
 * their `loading.tsx`, never the bare block, so a skeleton and its content share a
 * footprint and nothing jumps when the rows arrive.
 */
export function PageHeadingSkeleton({ eyebrow = false, subline = true, pill = false }: { eyebrow?: boolean; subline?: boolean; pill?: boolean }) {
  return (
    <div>
      {eyebrow ? <Skeleton width="4rem" height="0.75rem" style={{ marginBottom: '0.5rem' }} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton width="14rem" height="2.5rem" />
        {pill ? <Skeleton width="6rem" height="1.75rem" pill /> : null}
      </div>
      {subline ? <Skeleton width="18rem" height="1rem" style={{ marginTop: '0.5rem', maxWidth: '100%' }} /> : null}
    </div>
  );
}

export function SectionHeadingSkeleton({ aside = false }: { aside?: boolean }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <Skeleton width="6rem" height="0.75rem" />
      {aside ? <Skeleton width="3rem" height="0.75rem" /> : null}
    </div>
  );
}

export function TournamentCardSkeleton({ featured = false }: { featured?: boolean }) {
  return (
    <div className={cx('surface-raised rounded-card', featured ? 'p-5 md:p-6' : 'p-4')}>
      <div className="flex items-center justify-between gap-3">
        <Skeleton width="6rem" height="1.75rem" pill />
        <Skeleton width="5rem" height="1rem" />
      </div>
      <Skeleton width={featured ? '75%' : '66%'} height="2rem" style={{ marginTop: '1rem' }} />
      <Skeleton width="50%" height="1rem" style={{ marginTop: '0.5rem' }} />
      <div className="mt-4 flex gap-4">
        <Skeleton width="6rem" height="1rem" />
        <Skeleton width="7rem" height="1rem" />
      </div>
      <div className="mt-5">
        <div className="flex justify-between">
          <Skeleton width="7rem" height="1rem" />
          <Skeleton width="4rem" height="1rem" />
        </div>
        <Skeleton height="0.5rem" pill style={{ marginTop: '0.5rem' }} />
      </div>
    </div>
  );
}

export function MatchCardSkeleton() {
  return (
    <div className="surface-raised w-72 shrink-0 rounded-card p-3">
      <div className="flex items-center justify-between">
        <Skeleton width="4rem" height="1rem" />
        <Skeleton width="5rem" height="1.5rem" pill />
      </div>
      <div className="mt-3 space-y-2">
        <div className="flex justify-between">
          <Skeleton width="8rem" height="1.25rem" />
          <Skeleton width="2.5rem" height="1.25rem" />
        </div>
        <div className="flex justify-between">
          <Skeleton width="7rem" height="1.25rem" />
          <Skeleton width="2.5rem" height="1.25rem" />
        </div>
      </div>
    </div>
  );
}

export function DataTableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="surface-raised overflow-hidden rounded-card">
      <div className="flex gap-4 border-b border-border-subtle px-4 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} height="0.75rem" style={{ flex: '1' }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-border-subtle px-4 py-3 last:border-b-0">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} height="1rem" style={{ flex: '1' }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={cx('grid grid-cols-2 gap-3', count > 2 && 'md:grid-cols-4')}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="surface-raised rounded-card p-4">
          <Skeleton width="4rem" height="0.75rem" />
          <Skeleton width="6rem" height="1.5rem" style={{ marginTop: '0.5rem' }} />
          <Skeleton width="5rem" height="0.75rem" style={{ marginTop: '0.5rem' }} />
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton({ fields = 3, button = true }: { fields?: number; button?: boolean }) {
  return (
    <div className="space-y-5">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i}>
          <Skeleton width="6rem" height="0.75rem" />
          <Skeleton height="2.75rem" style={{ marginTop: '0.5rem' }} />
        </div>
      ))}
      {button ? <Skeleton width="12rem" height="3rem" /> : null}
    </div>
  );
}

export function CardListSkeleton({ count = 2, lines = 2 }: { count?: number; lines?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="surface-raised rounded-card p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <Skeleton width="12rem" height="1.25rem" style={{ maxWidth: '60%' }} />
            <Skeleton width="5rem" height="1.5rem" pill />
          </div>
          {Array.from({ length: lines }, (_, l) => (
            <Skeleton key={l} width={l === 0 ? '75%' : '50%'} height="1rem" style={{ marginTop: '0.5rem' }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StandingsSkeleton({ pools = 2 }: { pools?: number }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {Array.from({ length: pools }, (_, i) => (
        <div key={i} className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between">
            <Skeleton width="4rem" height="1.25rem" />
            <Skeleton width="7rem" height="0.75rem" />
          </div>
          <DataTableSkeleton rows={4} columns={5} />
        </div>
      ))}
    </div>
  );
}

export function BracketSkeleton() {
  return (
    <div className="surface-raised overflow-hidden rounded-card">
      <div className="flex flex-wrap items-center gap-4 p-3 md:p-4">
        <div className="min-w-0 flex-1">
          <Skeleton width="10rem" height="0.75rem" />
          <Skeleton width="14rem" height="1.25rem" style={{ marginTop: '0.75rem', maxWidth: '100%' }} />
          <Skeleton width="13rem" height="1.25rem" style={{ marginTop: '0.5rem', maxWidth: '100%' }} />
        </div>
        <Skeleton width="6rem" height="2.75rem" />
      </div>
      <div className="h-[280px] border-t border-border-subtle bg-bg-inset md:h-[420px]" />
    </div>
  );
}

export function CourtBoardSkeleton({ courts = 3 }: { courts?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: courts }, (_, i) => (
        <div key={i} className="space-y-3">
          <Skeleton width="5rem" height="1.25rem" />
          <MatchCardSkeleton />
          <MatchCardSkeleton />
        </div>
      ))}
    </div>
  );
}
