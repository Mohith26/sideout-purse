'use client';

import { useState } from 'react';
import { StatusPill } from '@sideout/ui';

import type { PurseCallStatus } from '../../db/schema';
import { cx } from '../../lib/cx';
import { formatDateTime } from '../../lib/format';
import { PURSE_CALL_STATUS_PILL } from '../status/pills';

/**
 * `/admin/purse` (spec 5.3, item 7): every `purse_calls` row, newest first, as a dense
 * table with the request and response one tap away. Secrets are never stored, so nothing
 * here can leak one; what is shown is exactly what left and what came back.
 */
export type PurseCallRow = {
  id: string;
  requestId: string;
  method: string;
  path: string;
  idempotencyKey: string | null;
  subject: { type: string; id: string } | null;
  status: PurseCallStatus;
  responseStatus: number | null;
  replayed: boolean | null;
  durationMs: number | null;
  error: string | null;
  startedAt: string;
  request: unknown;
  response: unknown;
};

function Json({ value }: { value: unknown }) {
  return <pre className="so-mono max-w-full overflow-x-auto rounded-input bg-bg-inset p-3 text-[0.8125rem] leading-relaxed text-text-secondary">{value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}</pre>;
}

export function PurseCallsTable({ calls, timeZone }: { calls: readonly PurseCallRow[]; timeZone: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="surface-raised relative overflow-x-auto rounded-card" tabIndex={0} role="group" aria-label="Purse calls" data-testid="purse-calls">
      <table className="w-full min-w-[72rem] border-collapse text-body">
        <caption className="sr-only">Every request Sideout made to Purse, newest first</caption>
        <thead>
          <tr className="border-b border-border-subtle">
            {['At', 'Call', 'Status', 'Idempotency key', 'Subject', 'Duration', ''].map((h) => (
              <th key={h} scope="col" className={cx('px-3 py-2.5 type-label whitespace-nowrap text-text-tertiary first:pl-4 last:pr-4', h === 'Duration' && 'text-end')}>
                {h === '' ? <span className="sr-only">Detail</span> : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {calls.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-6 text-text-secondary">
                Nothing has been sent to Purse.
              </td>
            </tr>
          ) : null}
          {calls.map((call) => {
            const expanded = open === call.id;
            return [
              <tr key={call.id} className={cx('border-b border-border-subtle', expanded && 'bg-bg-overlay')} data-testid="purse-call-row">
                <td className="tabular px-4 py-2.5 whitespace-nowrap text-text-secondary">{formatDateTime(call.startedAt, timeZone)}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="so-mono [word-break:normal] text-text-primary">
                    {call.method} {call.path}
                  </span>
                  {call.replayed === true ? <span className="ml-2 type-label text-text-tertiary">replayed</span> : null}
                </td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-2">
                    <StatusPill spec={PURSE_CALL_STATUS_PILL[call.status]} size="sm" />
                    {call.responseStatus === null ? null : <span className="tabular type-label text-text-tertiary">{call.responseStatus}</span>}
                  </span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="so-mono [word-break:normal] text-text-secondary">{call.idempotencyKey ?? '—'}</span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-text-secondary">{call.subject === null ? '—' : `${call.subject.type} ${call.subject.id}`}</td>
                <td className="tabular px-3 py-2.5 text-end whitespace-nowrap text-text-secondary">{call.durationMs === null ? '—' : `${call.durationMs} ms`}</td>
                <td className="px-3 py-2.5 pr-4 text-end">
                  <button type="button" onClick={() => setOpen(expanded ? null : call.id)} aria-expanded={expanded} aria-controls={`call-${call.id}`} className="target inline-flex items-center rounded-input px-2 type-label text-text-secondary hover:text-text-primary">
                    {expanded ? 'Hide' : 'Detail'}
                  </button>
                </td>
              </tr>,
              expanded ? (
                <tr key={`${call.id}-detail`} id={`call-${call.id}`} className="border-b border-border-subtle bg-bg-inset">
                  <td colSpan={7} className="px-4 py-4">
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[0.8125rem] text-text-secondary sm:grid-cols-[auto_minmax(0,1fr)]">
                      <dt className="type-label">request id</dt>
                      <dd className="so-mono">{call.requestId}</dd>
                      {call.error === null ? null : (
                        <>
                          <dt className="type-label text-fault">error</dt>
                          <dd className="text-fault">{call.error}</dd>
                        </>
                      )}
                    </dl>
                    <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <div>
                        <h3 className="type-label text-text-tertiary">Request</h3>
                        <Json value={call.request} />
                      </div>
                      <div>
                        <h3 className="type-label text-text-tertiary">Response</h3>
                        <Json value={call.response} />
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
