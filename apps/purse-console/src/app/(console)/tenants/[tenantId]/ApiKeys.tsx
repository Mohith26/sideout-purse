'use client';

import { useState } from 'react';
import { Button, Card, DataTable, Field, Input, Mono, Notice, Select } from '@sideout/ui';
import type { ApiError, ApiKeyEnvironment, ApiKeyKind, ApiKeyResource } from '@purse/types';

import { ErrorNotice } from '../../../../components/ErrorNotice';
import { RevealOnce } from '../../../../components/RevealOnce';
import { StateChip } from '../../../../components/StateChip';
import { api, newIdempotencyKey } from '../../../../lib/client';
import { formatInstant } from '../../../../lib/format';

/**
 * API keys (spec 4.10 "create, reveal once, revoke"): the list with prefix, environment,
 * scope and last use; a create form whose result shows the plaintext exactly once (the
 * API stores only a hash and a replay of the request carries none); a revoke with a
 * confirm step. Admin only for the writes.
 */
export function ApiKeys({ tenantId, initial, admin }: { tenantId: string; initial: ApiKeyResource[]; admin: boolean }) {
  const [keys, setKeys] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<ApiKeyKind>('secret');
  const [environment, setEnvironment] = useState<ApiKeyEnvironment>('sandbox');
  const [operator, setOperator] = useState(false);
  const [label, setLabel] = useState('');
  const [revealed, setRevealed] = useState<ApiKeyResource | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const res = await api.post<ApiKeyResource>(
      `/tenants/${tenantId}/api-keys`,
      { kind, environment, scopes: kind === 'secret' && operator ? ['operator'] : [], label: label.trim() === '' ? null : label.trim() },
      { idempotencyKey: newIdempotencyKey() },
    );
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRevealed(res.data);
    setKeys((current) => [{ ...res.data, plaintext: null }, ...current]);
    setCreating(false);
    setLabel('');
    setOperator(false);
  }

  async function revoke(keyId: string) {
    setBusy(true);
    setError(null);
    const res = await api.post<ApiKeyResource>(`/tenants/${tenantId}/api-keys/${keyId}/revoke`, {});
    setBusy(false);
    setRevoking(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setKeys((current) => current.map((each) => (each.id === keyId ? res.data : each)));
  }

  return (
    <Card
      title="API keys"
      actions={
        admin ? (
          <Button small variant="primary" onClick={() => setCreating((value) => !value)} disabled={busy}>
            {creating ? 'Close' : 'Create key'}
          </Button>
        ) : undefined
      }
    >
      {revealed === null ? null : (
        <RevealOnce title={`${revealed.kind === 'secret' ? 'Secret' : 'Publishable'} key created`} secret={revealed.plaintext ?? ''} onDismiss={() => setRevealed(null)}>
          Copy it now. The plaintext is shown once and stored only as a hash; a replay of the same request returns the key without it.
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
          <Field id="key-kind" label="Kind">
            <Select id="key-kind" value={kind} onChange={(event) => setKind(event.target.value as ApiKeyKind)}>
              <option value="secret">secret (server-to-server)</option>
              <option value="publishable">publishable (browser, iframe bootstrap)</option>
            </Select>
          </Field>
          <Field id="key-env" label="Environment">
            <Select id="key-env" value={environment} onChange={(event) => setEnvironment(event.target.value as ApiKeyEnvironment)}>
              <option value="sandbox">sandbox</option>
              <option value="live">live</option>
            </Select>
          </Field>
          <Field id="key-label" label="Label" hint="Optional, up to 100 characters.">
            <Input id="key-label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} />
          </Field>
          {kind === 'secret' ? (
            <Field id="key-operator" label="Scope" hint="The operator scope may issue credits and close operator_close contests.">
              <label className="row" style={{ minHeight: 'var(--target-min)' }}>
                <input id="key-operator" type="checkbox" checked={operator} onChange={(event) => setOperator(event.target.checked)} />
                <span>operator</span>
              </label>
            </Field>
          ) : null}
          <div className="form__wide so-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              Create key
            </Button>
          </div>
        </form>
      ) : null}
      {error === null ? null : <ErrorNotice error={error} />}
      {!admin ? <Notice title="Read only">Only an admin can create or revoke keys.</Notice> : null}
      <DataTable
        caption="API keys"
        rows={keys}
        rowKey={(row) => row.id}
        empty="No keys."
        columns={[
          { key: 'prefix', header: 'Prefix', render: (row) => <Mono title={row.id}>{row.keyPrefix}…</Mono> },
          { key: 'label', header: 'Label', render: (row) => row.label ?? '—' },
          { key: 'kind', header: 'Kind', render: (row) => row.kind },
          { key: 'env', header: 'Env', render: (row) => <StateChip value={row.environment} /> },
          { key: 'scopes', header: 'Scopes', render: (row) => (row.scopes.length === 0 ? '—' : row.scopes.join(', ')) },
          { key: 'lastUsed', header: 'Last used', render: (row) => formatInstant(row.lastUsedAt) },
          { key: 'status', header: 'Status', render: (row) => (row.revokedAt === null ? <StateChip value="active" /> : <StateChip value="revoked" />) },
          {
            key: 'actions',
            header: '',
            render: (row) =>
              !admin || row.revokedAt !== null ? null : revoking === row.id ? (
                <span className="so-actions">
                  <Button small variant="danger" disabled={busy} onClick={() => revoke(row.id)}>
                    Confirm revoke
                  </Button>
                  <Button small disabled={busy} onClick={() => setRevoking(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button small disabled={busy} onClick={() => setRevoking(row.id)}>
                  Revoke
                </Button>
              ),
          },
        ]}
      />
    </Card>
  );
}
