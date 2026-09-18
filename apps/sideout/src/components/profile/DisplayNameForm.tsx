'use client';

import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { ActionButton, useToast } from '@sideout/ui';

import { api, fieldIssues } from '../../lib/api-client';
import { Field, TextInput } from '../ui/Form';
import { Notice } from '../ui/Notice';

/** The first sign-in leaves a default name; the profile asks for a real one, since names are public on rosters. */
export function DisplayNameForm({ current }: { current: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await api<{ user: { displayName: string } }>('/api/me', { method: 'PATCH', body: { displayName: name.trim() } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.code === 'validation_failed' ? (fieldIssues(result.error)['displayName'] ?? result.error.message) : result.error.message);
      return;
    }
    toast({ tone: 'success', title: `You are ${result.data.user.displayName} on the sand` });
    router.refresh();
  }
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="surface-inset space-y-3 rounded-card p-4" data-testid="display-name-form">
      <Notice tone="info" title="Pick the name other players will see">
        Your account has a placeholder name. Rosters, standings and the donor wall show this one.
      </Notice>
      <Field label="Your name" error={error ?? undefined}>
        {({ id, describedBy, invalid }) => <TextInput id={id} name="displayName" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} maxLength={60} />}
      </Field>
      <ActionButton type="submit" variant="secondary" disabled={busy || name.trim().length < 2} aria-busy={busy}>
        {busy ? 'Saving…' : 'Save name'}
      </ActionButton>
    </form>
  );
}
