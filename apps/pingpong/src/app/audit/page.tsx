import { redirect } from 'next/navigation';
import { Chip, DataTable, Mono, type Column } from '@sideout/ui';

import { listPurseCalls, type PurseCallView } from '../../purse';
import { pagePlayer } from '../../server/auth/current-player';
import { appContext } from '../../server/context';

export const dynamic = 'force-dynamic';

/** The Purse call audit: every request the server made, newest first. Bodies stay in the table; keys never reach it at all. */
export default async function AuditPage() {
  const app = appContext();
  const player = await pagePlayer({ db: app.db, sessionSecret: app.env.sessionSecret, now: new Date() });
  if (player === null) redirect('/');
  const { calls } = await listPurseCalls(app.db, { limit: 100 });
  const columns: Array<Column<PurseCallView>> = [
    { key: 'when', header: 'When', nowrap: true, render: (c) => c.startedAt.replace('T', ' ').slice(0, 19) },
    { key: 'call', header: 'Call', render: (c) => <Mono>{`${c.method} ${c.path}`}</Mono> },
    { key: 'status', header: 'Status', render: (c) => <Chip tone={c.status === 'succeeded' ? 'surf' : c.status === 'in_flight' ? 'neutral' : 'fault'}>{c.replayed === true ? `${c.status} (replayed)` : c.status}</Chip> },
    { key: 'http', header: 'HTTP', numeric: true, render: (c) => c.responseStatus ?? '—' },
    { key: 'ms', header: 'ms', numeric: true, render: (c) => c.durationMs ?? '—' },
    { key: 'key', header: 'Idempotency key', nowrap: true, render: (c) => (c.idempotencyKey === null ? '' : <Mono title={c.idempotencyKey}>{c.idempotencyKey.length > 28 ? `${c.idempotencyKey.slice(0, 28)}…` : c.idempotencyKey}</Mono>) },
    { key: 'subject', header: 'Subject', nowrap: true, render: (c) => (c.subject === null ? '' : `${c.subject.type} ${c.subject.id.slice(0, 12)}…`) },
  ];
  return (
    <div className="flex flex-col gap-4 py-6">
      <h1 className="type-display-l">Purse calls</h1>
      <p className="type-body text-text-secondary">Every request this server made to Purse, recorded before it left and completed when it returned. The same audit Sideout keeps, on the second tenant.</p>
      <div data-testid="purse-calls">
        <DataTable columns={columns} rows={calls} rowKey={(c) => c.id} empty="No calls yet." caption="Purse calls, newest first" />
      </div>
    </div>
  );
}
