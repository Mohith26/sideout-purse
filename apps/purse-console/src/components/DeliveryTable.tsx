'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, DataTable, Mono } from '@sideout/ui';
import type { ApiError, ConsoleDeliveryResource } from '@purse/types';

import { api } from '../lib/client';
import { formatInstant } from '../lib/format';
import { ErrorNotice } from './ErrorNotice';
import { StateChip } from './StateChip';

/**
 * The delivery log (spec 4.9 "the operator console can inspect and manually replay any
 * delivery"): every delivery with its attempt history unfolded, and a Replay that queues
 * the same event to the same endpoint as a new delivery, which appears at the top.
 */
export function DeliveryTable({ initial, showTenant = false }: { initial: ConsoleDeliveryResource[]; showTenant?: boolean }) {
  const [deliveries, setDeliveries] = useState(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  async function replay(delivery: ConsoleDeliveryResource) {
    setBusy(delivery.id);
    setError(null);
    const res = await api.post<ConsoleDeliveryResource>(`/tenants/${delivery.tenantId}/webhooks/deliveries/${delivery.id}/replay`, {});
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDeliveries((current) => [res.data, ...current]);
  }

  return (
    <div className="stack">
      {error === null ? null : <ErrorNotice error={error} />}
      <DataTable
        caption="Webhook deliveries"
        rows={deliveries}
        rowKey={(row) => row.id}
        empty="No deliveries match."
        columns={[
          { key: 'id', header: 'Delivery', render: (row) => <Mono title={row.id}>{row.id.slice(-8)}</Mono> },
          ...(showTenant ? [{ key: 'tenant', header: 'Tenant', render: (row: ConsoleDeliveryResource) => row.tenantName }] : []),
          { key: 'event', header: 'Event', render: (row) => <span>{row.eventType} <Mono title={row.eventId}>{row.eventId.slice(-8)}</Mono></span> },
          { key: 'endpoint', header: 'Endpoint', render: (row) => <Link href={`/tenants/${row.tenantId}/webhooks/${row.endpointId}`} className="so-link so-mono">{row.endpointUrl}</Link> },
          { key: 'status', header: 'Status', render: (row) => <StateChip value={row.status} /> },
          { key: 'attempt', header: 'Attempts', numeric: true, render: (row) => `${row.attempt}/${row.maxAttempts}` },
          { key: 'response', header: 'Last', numeric: true, render: (row) => row.responseStatus ?? '—' },
          { key: 'next', header: 'Next attempt', nowrap: true, render: (row) => formatInstant(row.nextAttemptAt) },
          { key: 'created', header: 'Created', nowrap: true, render: (row) => formatInstant(row.createdAt) },
          { key: 'replayOf', header: 'Replay of', render: (row) => (row.replayOf === null ? '—' : <Mono title={row.replayOf}>{row.replayOf.slice(-8)}</Mono>) },
          {
            key: 'actions',
            header: '',
            render: (row) => (
              <span className="so-actions">
                <Button
                  small
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                >
                  {open.has(row.id) ? 'Hide attempts' : `Attempts (${row.attempts.length})`}
                </Button>
                <Button small variant="primary" disabled={busy !== null} onClick={() => replay(row)}>
                  {busy === row.id ? 'Replaying…' : 'Replay'}
                </Button>
              </span>
            ),
          },
        ]}
      />
      {deliveries
        .filter((row) => open.has(row.id))
        .map((row) => (
          <div key={row.id} className="so-card">
            <div className="so-card__head">
              <h2 className="so-card__title">
                Attempts for <Mono>{row.id}</Mono>
              </h2>
            </div>
            <DataTable
              rows={row.attempts}
              rowKey={(attempt) => attempt.id}
              empty="No attempt yet; the dispatcher picks it up at its next poll."
              columns={[
                { key: 'n', header: '#', numeric: true, render: (attempt) => attempt.attempt },
                { key: 'started', header: 'Started', render: (attempt) => formatInstant(attempt.startedAt) },
                { key: 'duration', header: 'Duration', numeric: true, render: (attempt) => `${attempt.durationMs} ms` },
                { key: 'status', header: 'Response', numeric: true, render: (attempt) => attempt.responseStatus ?? '—' },
                { key: 'error', header: 'Error', render: (attempt) => attempt.error ?? '—' },
              ]}
            />
          </div>
        ))}
    </div>
  );
}
