'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, DataTable, Field, Input, Mono } from '@sideout/ui';
import type { ApiError, OperatorFlagResource } from '@purse/types';

import { api } from '../lib/client';
import { formatInstant, titleCase } from '../lib/format';
import { ErrorNotice } from './ErrorNotice';
import { StateChip } from './StateChip';

export function FlagQueue({ initial }: { initial: OperatorFlagResource[] }) {
  const [flags, setFlags] = useState(initial);
  const [acting, setActing] = useState<{ id: string; status: 'reviewed' | 'dismissed' } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function resolve() {
    if (acting === null) return;
    const flag = flags.find((each) => each.id === acting.id);
    if (flag === undefined) return;
    setBusy(true);
    setError(null);
    const res = await api.post<OperatorFlagResource>(`/tenants/${flag.tenantId}/flags/${flag.id}/review`, { status: acting.status, ...(note.trim() === '' ? {} : { note: note.trim() }) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setFlags((current) => current.map((each) => (each.id === flag.id ? res.data : each)));
    setActing(null);
    setNote('');
  }

  return (
    <div className="stack">
      {error === null ? null : <ErrorNotice error={error} />}
      <DataTable
        caption="Operator flags"
        rows={flags}
        rowKey={(row) => row.id}
        empty="Nothing to review."
        columns={[
          { key: 'kind', header: 'Kind', render: (row) => titleCase(row.kind) },
          {
            key: 'users',
            header: 'Users',
            render: (row) => (
              <div className="stack" style={{ gap: '2px' }}>
                {row.users.map((user) => (
                  <Link key={user.id} href={`/tenants/${row.tenantId}/users/${user.id}`} className="so-link">
                    {user.displayName ?? user.externalId} <Mono>{user.externalId}</Mono>
                  </Link>
                ))}
              </div>
            ),
          },
          { key: 'status', header: 'Status', render: (row) => <StateChip value={row.status} /> },
          { key: 'raised', header: 'Raised', nowrap: true, render: (row) => formatInstant(row.createdAt) },
          { key: 'reviewed', header: 'Reviewed', render: (row) => (row.reviewedAt === null ? '—' : `${formatInstant(row.reviewedAt)} by ${row.reviewedBy ?? '?'}`) },
          {
            key: 'actions',
            header: '',
            render: (row) => (
              <span className="so-actions">
                <Button small onClick={() => setOpen((current) => (current === row.id ? null : row.id))}>
                  {open === row.id ? 'Hide detail' : 'Detail'}
                </Button>
                {row.status === 'open' && acting === null ? (
                  <>
                    <Button small variant="primary" onClick={() => setActing({ id: row.id, status: 'reviewed' })}>
                      Resolve
                    </Button>
                    <Button small onClick={() => setActing({ id: row.id, status: 'dismissed' })}>
                      Dismiss
                    </Button>
                  </>
                ) : null}
              </span>
            ),
          },
        ]}
      />
      {open === null ? null : <pre className="pre">{JSON.stringify(flags.find((each) => each.id === open)?.detail ?? {}, null, 2)}</pre>}
      {acting === null ? null : (
        <div className="so-card">
          <div className="so-card__head">
            <h2 className="so-card__title">{acting.status === 'reviewed' ? 'Resolve flag' : 'Dismiss flag'}</h2>
          </div>
          <Field id="flag-note" label="Note" hint="Optional; recorded in the audit log with your operator id.">
            <Input id="flag-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
          </Field>
          <div className="so-actions">
            <Button variant="primary" disabled={busy} onClick={resolve}>
              {acting.status === 'reviewed' ? 'Confirm resolve' : 'Confirm dismiss'}
            </Button>
            <Button disabled={busy} onClick={() => setActing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
