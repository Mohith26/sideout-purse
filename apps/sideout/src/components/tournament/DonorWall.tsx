import { cx } from '../../lib/cx';
import { formatCents, formatDate } from '../../lib/format';
import { DataTable, type DataTableColumn } from '../ui/DataTable';

/** A completed gift as the donor wall lists it; the shape `server/impact.ts` produces. */
export type DonorWallRow = { id: string; kind: 'team_entry' | 'supporter' | 'anonymous'; label: string; amountCents: string; currency: string; at: string };

const KIND_LABEL: Record<DonorWallRow['kind'], string> = { team_entry: 'Team entry', supporter: 'Supporter', anonymous: 'Supporter' };

/** Every completed gift, newest first: who, what kind, when and how much, in ember because it is a charity figure. */
export function DonorWall({ rows, timeZone }: { rows: readonly DonorWallRow[]; timeZone: string }) {
  const columns: Array<DataTableColumn<DonorWallRow>> = [
    { key: 'who', header: 'Gift from', render: (d) => <span className={cx('font-medium', d.kind === 'anonymous' ? 'text-text-secondary' : 'text-text-primary')}>{d.label}</span> },
    { key: 'kind', header: 'Type', hideBelowMd: true, render: (d) => <span className="text-text-secondary">{KIND_LABEL[d.kind]}</span> },
    { key: 'when', header: 'Date', hideBelowMd: true, render: (d) => <span className="tabular text-text-secondary">{formatDate(d.at, timeZone)}</span> },
    { key: 'amount', header: 'Amount', numeric: true, render: (d) => <span className="text-ember">{formatCents(d.amountCents, d.currency)}</span> },
  ];
  return <DataTable columns={columns} rows={rows} getRowKey={(d) => d.id} caption="Completed gifts, newest first" emptyLabel="No gifts yet." />;
}
