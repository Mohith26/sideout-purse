'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ActionButton, Icons, useToast } from '@sideout/ui';

import type { Division, TournamentFormat } from '../../db/schema';
import { api, fieldIssues } from '../../lib/api-client';
import { DIVISION_LABEL, FORMAT_LABEL } from '../status/labels';
import { Field, Fieldset, Select, TextInput } from '../ui/Form';
import { Notice } from '../ui/Notice';
import { dollarsToCents, fromWallClock } from './event-form-values';

/**
 * The event builder's form (spec 5.3, item 6): every field the admin routes accept, as a
 * create (`POST /api/admin/tournaments`) or an edit (`PATCH /api/admin/tournaments/:id`).
 * Cents are typed as dollars and sent as decimal cent strings (decision, phase 6: never a
 * float on the money path); times are typed in the venue's zone and sent as instants.
 */
export type EventFormOptions = {
  formats: readonly TournamentFormat[];
  divisions: readonly Division[];
  charities: ReadonlyArray<{ id: string; name: string }>;
  defaultTimeZone: string;
};

export type EventFormValues = {
  slug: string;
  name: string;
  subtitle: string;
  beneficiaryId: string;
  venueName: string;
  venueCity: string;
  venueRegion: string;
  venueTimezone: string;
  startsAt: string;
  endsAt: string;
  format: TournamentFormat;
  division: Division;
  maxTeams: string;
  entryDonation: string;
  fundraisingGoal: string;
};

export type EventFormLocks = { readOnly: boolean; draftOnly: boolean; minTeams: number };

export function EventForm({ mode, options, initial, tournamentId, locks }: { mode: 'create' | 'edit'; options: EventFormOptions; initial: EventFormValues; tournamentId?: string; locks: EventFormLocks }) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<EventFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const disabled = busy || locks.readOnly;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const next: Record<string, string> = {};
    const entryDonationCents = dollarsToCents(values.entryDonation);
    const fundraisingGoalCents = dollarsToCents(values.fundraisingGoal);
    const startsAt = fromWallClock(values.startsAt, values.venueTimezone);
    const endsAt = fromWallClock(values.endsAt, values.venueTimezone);
    const maxTeams = Number(values.maxTeams);
    if (values.name.trim().length < 3) next['name'] = 'At least three characters.';
    if (mode === 'create' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(values.slug)) next['slug'] = 'Lowercase words joined by hyphens, e.g. sandbar-classic-2026.';
    if (values.beneficiaryId === '') next['beneficiaryId'] = 'Choose the beneficiary.';
    if (entryDonationCents === null) next['entryDonation'] = 'A dollar amount with at most two decimals.';
    if (fundraisingGoalCents === null) next['fundraisingGoal'] = 'A dollar amount with at most two decimals.';
    if (startsAt === null) next['startsAt'] = 'A date and time.';
    if (endsAt === null) next['endsAt'] = 'A date and time.';
    if (startsAt !== null && endsAt !== null && endsAt < startsAt) next['endsAt'] = 'The end is before the start.';
    if (!Number.isInteger(maxTeams) || maxTeams < 2) next['maxTeams'] = 'At least two teams.';
    if (maxTeams < locks.minTeams) next['maxTeams'] = `${locks.minTeams} teams already hold a place.`;
    for (const key of ['venueName', 'venueCity', 'venueRegion'] as const) if (values[key].trim() === '') next[key] = 'Required.';
    setErrors(next);
    if (Object.keys(next).length > 0 || entryDonationCents === null || fundraisingGoalCents === null || startsAt === null || endsAt === null) return;

    const body: Record<string, unknown> = {
      name: values.name.trim(),
      subtitle: values.subtitle.trim() === '' ? (mode === 'create' ? undefined : null) : values.subtitle.trim(),
      venue: { name: values.venueName.trim(), city: values.venueCity.trim(), region: values.venueRegion.trim(), timezone: values.venueTimezone },
      startsAt,
      endsAt,
      maxTeams,
      fundraisingGoalCents,
      ...(locks.draftOnly ? { beneficiaryId: values.beneficiaryId, format: values.format, division: values.division, entryDonationCents } : {}),
    };
    if (mode === 'create') body['slug'] = values.slug;
    setBusy(true);
    const result =
      mode === 'create'
        ? await api<{ tournament: { id: string; slug: string } }>('/api/admin/tournaments', { method: 'POST', body })
        : await api<{ tournament: { id: string; slug: string } }>(`/api/admin/tournaments/${tournamentId}`, { method: 'PATCH', body });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === 'validation_failed') setErrors(fieldIssues(result.error));
      setFailure(result.error.message);
      return;
    }
    toast({ tone: 'success', title: mode === 'create' ? 'Event created as a draft' : 'Event saved' });
    if (mode === 'create') router.push(`/organizer/events/${result.data.tournament.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-8" data-testid="event-form">
      {failure === null ? null : (
        <Notice tone="error" title={mode === 'create' ? 'The event was not created' : 'The event was not saved'}>
          {failure}
        </Notice>
      )}
      {locks.readOnly ? (
        <Notice tone="info" title="This event is closed">
          A settled or cancelled event cannot be edited.
        </Notice>
      ) : null}
      <Fieldset legend="Event">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors['name']}>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={values.name} onChange={(e) => set('name', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} maxLength={120} />}
          </Field>
          <Field label="Slug" error={errors['slug']} hint={mode === 'create' ? 'The public address: /t/<slug>.' : 'Fixed once created.'}>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={values.slug} onChange={(e) => set('slug', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled || mode === 'edit'} className="so-mono" />}
          </Field>
          <Field label="Subtitle" meta="optional" error={errors['subtitle']} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <TextInput id={id} value={values.subtitle} onChange={(e) => set('subtitle', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} maxLength={200} />}
          </Field>
          <Field label="Beneficiary" error={errors['beneficiaryId']} hint={locks.draftOnly ? undefined : 'Fixed once registration opens.'}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} value={values.beneficiaryId} onChange={(e) => set('beneficiaryId', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled || !locks.draftOnly}>
                <option value="">Choose…</option>
                {options.charities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Division" error={errors['division']}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} value={values.division} onChange={(e) => set('division', e.target.value as Division)} aria-describedby={describedBy} invalid={invalid} disabled={disabled || !locks.draftOnly}>
                {options.divisions.map((d) => (
                  <option key={d} value={d}>
                    {DIVISION_LABEL[d]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Format" error={errors['format']} hint={locks.draftOnly ? 'Double elimination is a follow-up; the engine draws these three.' : 'Fixed once registration opens.'}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} value={values.format} onChange={(e) => set('format', e.target.value as TournamentFormat)} aria-describedby={describedBy} invalid={invalid} disabled={disabled || !locks.draftOnly}>
                {options.formats.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Max teams" error={errors['maxTeams']} hint={locks.minTeams > 0 ? `${locks.minTeams} already hold a place.` : undefined}>
            {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={2} max={64} value={values.maxTeams} onChange={(e) => set('maxTeams', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} />}
          </Field>
        </div>
      </Fieldset>
      <Fieldset legend="Venue and schedule">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Venue" error={errors['venueName']}>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={values.venueName} onChange={(e) => set('venueName', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} />}
          </Field>
          <Field label="Time zone" error={errors['venueTimezone']} hint="IANA name; times below are in it.">
            {({ id, describedBy, invalid }) => <TextInput id={id} value={values.venueTimezone} onChange={(e) => set('venueTimezone', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} />}
          </Field>
          <Field label="City" error={errors['venueCity']}>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={values.venueCity} onChange={(e) => set('venueCity', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} />}
          </Field>
          <Field label="Region" error={errors['venueRegion']}>
            {({ id, describedBy, invalid }) => <TextInput id={id} value={values.venueRegion} onChange={(e) => set('venueRegion', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} />}
          </Field>
          <Field label="Starts" error={errors['startsAt']} hint="Moving the start moves every scheduled match until one begins.">
            {({ id, describedBy, invalid }) => <TextInput id={id} type="datetime-local" value={values.startsAt} onChange={(e) => set('startsAt', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} className="tabular" />}
          </Field>
          <Field label="Ends" error={errors['endsAt']}>
            {({ id, describedBy, invalid }) => <TextInput id={id} type="datetime-local" value={values.endsAt} onChange={(e) => set('endsAt', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} className="tabular" />}
          </Field>
        </div>
      </Fieldset>
      <Fieldset legend="Donations" description="Real dollars through Stripe, never a stake. Contest prizes are POINTS in Purse and are shaped by sponsor contributions, a separate ledger.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Entry donation per team" error={errors['entryDonation']} hint={locks.draftOnly ? 'USD. Zero means free entry.' : 'Fixed once registration opens.'}>
            {({ id, describedBy, invalid }) => <TextInput id={id} inputMode="decimal" value={values.entryDonation} onChange={(e) => set('entryDonation', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled || !locks.draftOnly} className="tabular" />}
          </Field>
          <Field label="Fundraising goal" error={errors['fundraisingGoal']} hint="USD.">
            {({ id, describedBy, invalid }) => <TextInput id={id} inputMode="decimal" value={values.fundraisingGoal} onChange={(e) => set('fundraisingGoal', e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={disabled} className="tabular" />}
          </Field>
        </div>
      </Fieldset>
      <ActionButton type="submit" variant={mode === 'create' ? 'primary' : 'secondary'} large disabled={disabled} aria-busy={busy} iconStart={mode === 'create' ? <Icons.plus size={18} /> : <Icons.check size={18} />}>
        {busy ? 'Saving…' : mode === 'create' ? 'Create the event as a draft' : 'Save changes'}
      </ActionButton>
    </form>
  );
}
