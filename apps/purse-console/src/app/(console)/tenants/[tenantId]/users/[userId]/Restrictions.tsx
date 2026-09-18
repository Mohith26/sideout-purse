'use client';

import { useState } from 'react';
import { Button, Card, DataTable, Field, Input, Select } from '@sideout/ui';
import { OPERATOR_RESTRICTION_KINDS, type ApiError, type ConsoleRestrictionResource } from '@purse/types';

import { ErrorNotice } from '../../../../../../components/ErrorNotice';
import { StateChip } from '../../../../../../components/StateChip';
import { api } from '../../../../../../lib/client';
import { formatInstant, titleCase } from '../../../../../../lib/format';

type Kind = (typeof OPERATOR_RESTRICTION_KINDS)[number];

/** Restrictions management (spec 4.10): place a platform block, velocity lock or cool-off with a reason; lift one the operator placed. A user's own self-exclusion is never lifted here. */
export function Restrictions({ tenantId, userId, initial }: { tenantId: string; userId: string; initial: ConsoleRestrictionResource[] }) {
  const [restrictions, setRestrictions] = useState(initial);
  const [placing, setPlacing] = useState(false);
  const [kind, setKind] = useState<Kind>('platform_block');
  const [reason, setReason] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [lifting, setLifting] = useState<string | null>(null);
  const temporary = kind !== 'platform_block';

  async function place() {
    setBusy(true);
    setError(null);
    const res = await api.post<ConsoleRestrictionResource>(`/tenants/${tenantId}/users/${userId}/restrictions`, {
      kind,
      reason: reason.trim(),
      endsAt: endsAt === '' ? null : new Date(endsAt).toISOString(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRestrictions((current) => [res.data, ...current]);
    setPlacing(false);
    setReason('');
    setEndsAt('');
  }

  async function lift(id: string) {
    setBusy(true);
    setError(null);
    const res = await api.post<ConsoleRestrictionResource>(`/tenants/${tenantId}/restrictions/${id}/lift`, {});
    setBusy(false);
    setLifting(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRestrictions((current) => current.map((each) => (each.id === id ? res.data : each)));
  }

  return (
    <Card
      title="Restrictions"
      actions={
        <Button small variant="primary" disabled={busy} onClick={() => setPlacing((value) => !value)}>
          {placing ? 'Close' : 'Place restriction'}
        </Button>
      }
    >
      {placing ? (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void place();
          }}
        >
          <Field id="restriction-kind" label="Kind">
            <Select id="restriction-kind" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
              {OPERATOR_RESTRICTION_KINDS.map((each) => (
                <option key={each} value={each}>
                  {titleCase(each)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="restriction-ends" label="Ends at" hint={temporary ? 'Required for a temporary restriction.' : 'Optional for a platform block.'}>
            <Input id="restriction-ends" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} required={temporary} />
          </Field>
          <Field id="restriction-reason" label="Reason" hint="Required; kept on the row and in the audit log, never shown to the partner.">
            <Input id="restriction-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={500} />
          </Field>
          <div className="form__wide so-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              Place {titleCase(kind)}
            </Button>
          </div>
        </form>
      ) : null}
      {error === null ? null : <ErrorNotice error={error} />}
      <DataTable
        caption="Restrictions"
        rows={restrictions}
        rowKey={(row) => row.id}
        empty="No restrictions."
        columns={[
          { key: 'kind', header: 'Kind', render: (row) => titleCase(row.kind) },
          { key: 'active', header: 'In force', render: (row) => <StateChip value={row.active ? 'active' : row.liftedAt === null ? 'expired' : 'lifted'} /> },
          { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
          { key: 'starts', header: 'Starts', render: (row) => formatInstant(row.startsAt) },
          { key: 'ends', header: 'Ends', render: (row) => formatInstant(row.endsAt) },
          { key: 'by', header: 'Placed by', render: (row) => row.createdBy },
          { key: 'lifted', header: 'Lifted', render: (row) => (row.liftedAt === null ? '—' : `${formatInstant(row.liftedAt)} by ${row.liftedBy ?? '?'}`) },
          {
            key: 'actions',
            header: '',
            render: (row) =>
              !row.active ? null : lifting === row.id ? (
                <span className="so-actions">
                  <Button small variant="danger" disabled={busy} onClick={() => lift(row.id)}>
                    Confirm lift
                  </Button>
                  <Button small disabled={busy} onClick={() => setLifting(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button small disabled={busy} onClick={() => setLifting(row.id)}>
                  Lift
                </Button>
              ),
          },
        ]}
      />
    </Card>
  );
}
