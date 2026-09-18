import { Card, Chip, Label, Notice, Pre } from '../../../components/ui';
import { database } from '../../../db/client';
import { env } from '../../../env';
import { listPurseCalls } from '../../../purse';
import { pageUser } from '../../../server/auth/current-user';

export const dynamic = 'force-dynamic';

/** Every `purse_calls` row, newest first, with the full request and response (spec 5.3, item 7). Open this when an engineer asks how the integration behaves. */
export default async function AdminPursePage({ searchParams }: { searchParams: Promise<{ before?: string; subjectType?: string; subjectId?: string }> }) {
  const { db } = database();
  const user = await pageUser({ db, sessionSecret: env().sessionSecret, now: new Date() });
  if (user?.role !== 'organizer') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="display text-display-l text-text-primary">Purse calls</h1>
        <Notice tone="warning" title="Organizers only">Sign in as an organizer to see the Purse audit.</Notice>
      </div>
    );
  }
  const query = await searchParams;
  const subject = query.subjectType !== undefined && query.subjectId !== undefined ? { type: query.subjectType, id: query.subjectId } : undefined;
  const page = await listPurseCalls(db, { limit: 50, before: query.before, subject });
  const config = env().purse;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Label>Admin</Label>
        <h1 className="display text-display-l text-text-primary">Purse calls</h1>
        <p className="text-body text-text-secondary">
          Every request Sideout made to Purse at <code>{config.apiUrl}</code>, newest first, with its idempotency key, request and response. Secrets are never stored.
          {subject === undefined ? '' : ` Filtered to ${subject.type} ${subject.id}.`}
        </p>
      </header>
      {page.calls.length === 0 ? <Notice title="No calls yet">Nothing has been sent to Purse.</Notice> : null}
      <ol className="flex flex-col gap-3">
        {page.calls.map((call) => (
          <li key={call.id}>
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular text-body font-semibold text-text-primary">
                  {call.method} {call.path}
                </span>
                <Chip tone={call.status === 'succeeded' ? 'positive' : call.status === 'in_flight' ? 'warning' : 'error'}>
                  {call.status}
                  {call.responseStatus === null ? '' : ` ${call.responseStatus}`}
                </Chip>
                {call.replayed === true ? <Chip tone="neutral">replayed</Chip> : null}
                {call.durationMs === null ? null : <Chip>{call.durationMs} ms</Chip>}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8125rem] text-text-secondary">
                <dt className="label">at</dt>
                <dd className="tabular">{call.startedAt}</dd>
                <dt className="label">request id</dt>
                <dd className="tabular break-all">{call.requestId}</dd>
                <dt className="label">idempotency key</dt>
                <dd className="tabular break-all">{call.idempotencyKey ?? '—'}</dd>
                <dt className="label">subject</dt>
                <dd className="break-all">{call.subject === null ? '—' : `${call.subject.type} ${call.subject.id}`}</dd>
                {call.error === null ? null : (
                  <>
                    <dt className="label text-fault">error</dt>
                    <dd className="text-fault">{call.error}</dd>
                  </>
                )}
              </dl>
              <details className="mt-3">
                <summary className="cursor-pointer text-body text-text-primary">Request</summary>
                <Pre value={call.request} />
              </details>
              <details className="mt-2">
                <summary className="cursor-pointer text-body text-text-primary">Response</summary>
                <Pre value={call.response} />
              </details>
            </Card>
          </li>
        ))}
      </ol>
      {page.nextBefore === null ? null : (
        <a href={`/admin/purse?before=${encodeURIComponent(page.nextBefore)}${subject === undefined ? '' : `&subjectType=${subject.type}&subjectId=${subject.id}`}`} className="text-body text-volt">
          Older calls
        </a>
      )}
    </div>
  );
}
