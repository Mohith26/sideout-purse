'use client';

import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';
import { ActionButton, Icons, useToast } from '@sideout/ui';

import { api, fieldIssues } from '../../lib/api-client';
import { normalizePhone } from '../../lib/phone';
import { Field, TextInput } from '../ui/Form';
import { Notice } from '../ui/Notice';

/**
 * Step 0 of registration (spec 5.3, "create team, invite partner by phone"): name the
 * pair and give the partner's number. `POST /api/teams` creates the team as `forming` and
 * the partner joins by signing in with that number; the captain lands on the register
 * page to wait for them.
 */
export function CreateTeamForm({ slug, tournamentName }: { slug: string; tournamentName: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setFailure(null);
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next['name'] = 'Give the team a name of at least two characters.';
    const partnerPhone = normalizePhone(phone);
    if (partnerPhone === null) next['partnerPhone'] = 'Enter your partner’s number: ten US digits, or international with the country code.';
    setErrors(next);
    if (Object.keys(next).length > 0 || partnerPhone === null) return;
    setBusy(true);
    const result = await api<{ team: { id: string; name: string } }>('/api/teams', { method: 'POST', body: { tournamentSlug: slug, name: name.trim(), partnerPhone } });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === 'validation_failed') setErrors(fieldIssues(result.error));
      else setFailure(result.error.message);
      return;
    }
    toast({ tone: 'success', title: `${result.data.team.name} is forming`, body: 'Your partner joins by signing in with the number you gave.' });
    router.push(`/t/${slug}/register`);
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="surface-raised space-y-4 rounded-card p-4 md:p-5" data-testid="create-team-form">
      {failure === null ? null : (
        <Notice tone="error" title="The team was not created">
          {failure}
        </Notice>
      )}
      <Field label="Team name" error={errors['name']} hint={`How the pair is announced at ${tournamentName}.`}>
        {({ id, describedBy, invalid }) => <TextInput id={id} name="name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} maxLength={60} />}
      </Field>
      <Field label="Partner’s phone" error={errors['partnerPhone']} hint="They accept the invite by signing in with this number.">
        {({ id, describedBy, invalid }) => <TextInput id={id} name="partnerPhone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 415 555 0123" value={phone} onChange={(e) => setPhone(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} />}
      </Field>
      <ActionButton type="submit" variant="primary" large block disabled={busy} aria-busy={busy} iconStart={<Icons.users size={18} />}>
        {busy ? 'Creating…' : 'Create the team and invite my partner'}
      </ActionButton>
    </form>
  );
}
