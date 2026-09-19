'use client';

import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { ActionButton, Field, Input, Notice } from '@sideout/ui';

import { api } from '../lib/api-client';

export function SignInForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [officeCode, setOfficeCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Disabled until React has taken the form over, so a native submit can never fire without the handler.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await api<{ player: { id: string; name: string } }>('/api/session', { body: { name, officeCode } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.push('/ladder');
    router.refresh();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" data-testid="sign-in-form">
      <Field id="name" label="Your name">
        <Input id="name" name="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={40} autoComplete="nickname" />
      </Field>
      <Field id="office-code" label="Office code" hint="The word on the whiteboard by the table.">
        <Input id="office-code" name="officeCode" type="password" value={officeCode} onChange={(event) => setOfficeCode(event.target.value)} required autoComplete="off" />
      </Field>
      {error === null ? null : (
        <Notice tone="error" title="Not signed in">
          {error}
        </Notice>
      )}
      <ActionButton variant="primary" type="submit" disabled={busy || !hydrated}>
        {busy ? 'Signing in…' : 'Sign in'}
      </ActionButton>
    </form>
  );
}

/** A store that never changes: `useSyncExternalStore` then answers false on the server and true once hydrated. */
function subscribeNever(): () => void {
  return () => undefined;
}
