'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@sideout/ui';
import type { ApiError } from '@purse/types';

import { ErrorNotice } from '../../../components/ErrorNotice';
import { api } from '../../../lib/client';

export function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next !== again) {
      setError({ type: 'invalid_request', code: 'password_mismatch', message: 'The new passwords do not match' });
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.post<{ changed: boolean; otherSessionsRevoked: number }>('/auth/password', { currentPassword: current, newPassword: next });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDone(res.data.otherSessionsRevoked);
    setCurrent('');
    setNext('');
    setAgain('');
  }

  return (
    <form className="form form--narrow" onSubmit={submit}>
      <Field id="pw-current" label="Current password">
        <Input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} />
      </Field>
      <Field id="pw-next" label="New password" hint="At least 12 characters.">
        <Input id="pw-next" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(event) => setNext(event.target.value)} />
      </Field>
      <Field id="pw-again" label="New password again">
        <Input id="pw-again" type="password" autoComplete="new-password" required minLength={12} value={again} onChange={(event) => setAgain(event.target.value)} />
      </Field>
      {error === null ? null : <ErrorNotice error={error} />}
      {done === null ? null : <Notice tone="positive" title="Password changed">{done} other session{done === 1 ? '' : 's'} signed out.</Notice>}
      <div>
        <Button type="submit" variant="primary" disabled={busy}>
          Change password
        </Button>
      </div>
    </form>
  );
}
