import type { ReactNode } from 'react';

import { cx } from '../../lib/cx';

/**
 * Dense, table-driven data for standings, donor walls and the organizer console. Numeric
 * columns are right-aligned and tabular. Scrolls horizontally inside its own box at narrow
 * widths rather than breaking the page; the box is a focusable named region so a keyboard
 * can scroll it (WCAG 2.1.1).
 */
export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  align?: 'start' | 'end';
  numeric?: boolean;
  /** Tailwind width classes for every cell in the column, e.g. `w-12`, or `w-full max-w-0` for the one column that truncates. */
  width?: string;
  /** Hide below the md breakpoint. */
  hideBelowMd?: boolean;
};

export type DataTableProps<Row> = {
  columns: ReadonlyArray<DataTableColumn<Row>>;
  rows: readonly Row[];
  getRowKey: (row: Row) => string;
  caption: string;
  captionVisible?: boolean;
  emptyLabel?: string;
  className?: string;
  rowClassName?: (row: Row) => string | undefined;
  /** Extra `data-*` attributes per row, e.g. a stable id for a FLIP reorder to measure. */
  rowAttributes?: (row: Row) => Record<`data-${string}`, string | number>;
};

export function DataTable<Row>({ columns, rows, getRowKey, caption, captionVisible = false, emptyLabel = 'Nothing to show yet.', className, rowClassName, rowAttributes }: DataTableProps<Row>) {
  return (
    <div className={cx('surface-raised relative overflow-x-auto rounded-card', className)} tabIndex={0} role="group" aria-label={caption}>
      <table className="w-full min-w-full border-collapse text-body">
        <caption className={cx('text-start type-label text-text-tertiary', captionVisible ? 'px-4 pt-3 pb-1' : 'sr-only')}>{caption}</caption>
        <thead>
          <tr className="border-b border-border-subtle">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cx('px-3 py-2.5 type-label whitespace-nowrap text-text-tertiary first:pl-4 last:pr-4', col.align === 'end' || col.numeric ? 'text-end' : 'text-start', col.width, col.hideBelowMd && 'hidden md:table-cell')}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-text-secondary">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={getRowKey(row)} className={cx('border-b border-border-subtle last:border-b-0', rowClassName?.(row))} {...rowAttributes?.(row)}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cx('px-3 py-2.5 align-middle first:pl-4 last:pr-4', col.align === 'end' || col.numeric ? 'text-end' : 'text-start', col.numeric && 'tabular whitespace-nowrap', col.width, col.hideBelowMd && 'hidden md:table-cell')}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
