'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Card, Field, Input } from '@sideout/ui';
import type { ApiError } from '@purse/types';

import { ErrorNotice } from '../../components/ErrorNotice';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const envelope = (await res.json().catch(() => ({}))) as { error?: ApiError };
      if (!res.ok) {
        setError(envelope.error ?? { type: 'internal_error', code: 'unhandled', message: 'Sign-in failed' });
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError({ type: 'internal_error', code: 'network', message: 'The console could not reach its server' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Purse console">
      <p className="console__lede">Operators only. Sign in with your console account.</p>
      <form onSubmit={submit} className="stack">
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field id="password" label="Password">
          <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {error === null ? null : <ErrorNotice error={error} title={error.type === 'authentication_error' ? 'Wrong email or password' : undefined} />}
        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
