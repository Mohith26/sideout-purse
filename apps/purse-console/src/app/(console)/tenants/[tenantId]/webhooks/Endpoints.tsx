'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, Card, DataTable, Field, Input, Mono } from '@sideout/ui';
import { WEBHOOK_EVENT_TYPES, type ApiError, type ConsoleEndpointResource, type WebhookEventType } from '@purse/types';

import { ErrorNotice } from '../../../../../components/ErrorNotice';
import { RevealOnce } from '../../../../../components/RevealOnce';
import { StateChip } from '../../../../../components/StateChip';
import { api, newIdempotencyKey } from '../../../../../lib/client';
import { formatInstant } from '../../../../../lib/format';

export function Endpoints({ tenantId, initial }: { tenantId: string; initial: ConsoleEndpointResource[] }) {
  const [endpoints, setEndpoints] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<Set<WebhookEventType>>(new Set(WEBHOOK_EVENT_TYPES));
  const [revealed, setRevealed] = useState<{ title: string; secret: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const base = `/tenants/${tenantId}/webhooks/endpoints`;

  function replace(updated: ConsoleEndpointResource) {
    setEndpoints((current) => current.map((each) => (each.id === updated.id ? { ...updated, secret: null } : each)));
  }

  async function create() {
    setBusy(true);
    setError(null);
    const res = await api.post<ConsoleEndpointResource>(base, { url: url.trim(), subscribedEvents: [...events], description: description.trim() === '' ? null : description.trim() }, { idempotencyKey: newIdempotencyKey() });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRevealed({ title: 'Endpoint created', secret: res.data.secret ?? '' });
    setEndpoints((current) => [{ ...res.data, secret: null }, ...current]);
    setCreating(false);
    setUrl('');
    setDescription('');
  }

  async function rotate(endpointId: string) {
    setBusy(true);
    setError(null);
    const res = await api.post<ConsoleEndpointResource>(`${base}/${endpointId}/rotate`, {});
    setBusy(false);
    setRotating(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRevealed({ title: 'Signing secret rotated', secret: res.data.secret ?? '' });
    replace(res.data);
  }

  async function toggle(endpoint: ConsoleEndpointResource) {
    setBusy(true);
    setError(null);
    const res = await api.patch<ConsoleEndpointResource>(`${base}/${endpoint.id}`, { status: endpoint.status === 'enabled' ? 'disabled' : 'enabled' });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    replace(res.data);
  }

  return (
    <Card
      title="Endpoints"
      actions={
        <Button small variant="primary" onClick={() => setCreating((value) => !value)} disabled={busy}>
          {creating ? 'Close' : 'Add endpoint'}
        </Button>
      }
    >
      {revealed === null ? null : (
        <RevealOnce title={revealed.title} secret={revealed.secret} onDismiss={() => setRevealed(null)}>
          Configure the receiver with this secret; it verifies `Purse-Signature` (HMAC-SHA256 over `t.body`). It is shown once.
        </RevealOnce>
      )}
      {creating ? (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field id="endpoint-url" label="URL" hint="https:// in production; http://localhost is allowed for a receiver on this machine.">
            <Input id="endpoint-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} maxLength={2000} />
          </Field>
          <Field id="endpoint-description" label="Description">
            <Input id="endpoint-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} />
          </Field>
          <fieldset className="form__wide so-field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Subscribed events</legend>
            <div className="row">
              {WEBHOOK_EVENT_TYPES.map((type) => (
                <label key={type} className="row" style={{ gap: 'var(--space-1)' }}>
                  <input
                    type="checkbox"
                    checked={events.has(type)}
                    onChange={(event) =>
                      setEvents((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(type);
                        else next.delete(type);
                        return next;
                      })
                    }
                  />
                  <span className="so-mono">{type}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form__wide so-actions">
            <Button type="submit" variant="primary" disabled={busy || events.size === 0}>
              Create endpoint
            </Button>
          </div>
        </form>
      ) : null}
      {error === null ? null : <ErrorNotice error={error} />}
      <DataTable
        caption="Webhook endpoints"
        rows={endpoints}
        rowKey={(row) => row.id}
        empty="No endpoints. Add one to start receiving events."
        columns={[
          {
            key: 'url',
            header: 'URL',
            render: (row) => (
              <Link href={`/tenants/${tenantId}/webhooks/${row.id}`} className="so-link so-mono">
                {row.url}
              </Link>
            ),
          },
          { key: 'description', header: 'Description', render: (row) => row.description ?? '—' },
          { key: 'events', header: 'Events', numeric: true, render: (row) => row.subscribedEvents.length },
          { key: 'status', header: 'Status', render: (row) => <StateChip value={row.status} /> },
          { key: 'created', header: 'Created', render: (row) => formatInstant(row.createdAt) },
          {
            key: 'actions',
            header: '',
            render: (row) => (
              <span className="so-actions">
                <Button small disabled={busy} onClick={() => toggle(row)}>
                  {row.status === 'enabled' ? 'Disable' : 'Enable'}
                </Button>
                {rotating === row.id ? (
                  <>
                    <Button small variant="danger" disabled={busy} onClick={() => rotate(row.id)}>
                      Confirm rotate
                    </Button>
                    <Button small disabled={busy} onClick={() => setRotating(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button small disabled={busy} onClick={() => setRotating(row.id)}>
                    Rotate secret
                  </Button>
                )}
                <Mono title={row.id}>{row.id.slice(-8)}</Mono>
              </span>
            ),
          },
        ]}
      />
    </Card>
  );
}
