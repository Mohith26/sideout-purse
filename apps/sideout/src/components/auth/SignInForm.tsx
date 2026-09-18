'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { ActionButton, Icons } from '@sideout/ui';

import { api, fieldIssues, type ApiResult } from '../../lib/api-client';
import { maskPhone, normalizePhone } from '../../lib/phone';
import { Field, TextInput } from '../ui/Form';
import { Notice, type NoticeTone } from '../ui/Notice';

/**
 * Phone sign-in in two steps on one screen: phone → code (plus an optional name the first
 * time). Every failure the routes can answer has a state here: a rate limit shows how long
 * to wait, a deployment with no SMS provider says so rather than pretending a text went
 * out, and a wrong code never reveals whether the phone is known. The screen keeps the
 * latest `codeId` and asks for the most recent message (docs/decisions.md, phase 6).
 */
type RequestData = { codeId: string; expiresAt: string; code?: string; hint?: string };
type VerifyData = { user: { id: string; displayName: string; role: string }; created: boolean };

type Blocker = { tone: NoticeTone; title: string; body?: string; retryAt?: number };

function blockerFor(result: ApiResult<unknown>): Blocker {
  if (result.ok) return { tone: 'error', title: 'Something went wrong' };
  const { error } = result;
  switch (error.code) {
    case 'too_many_requests':
      return { tone: 'attention', title: 'Too many attempts', body: 'Wait a moment before trying again.', ...(result.retryAfterMs === null ? {} : { retryAt: Date.now() + result.retryAfterMs }) };
    case 'sms_unavailable':
      return { tone: 'attention', title: 'Text messages are not available here yet', body: 'This deployment has no SMS provider configured, so no code can be sent. Ask the organizer for another way in.' };
    case 'code_invalid':
    case 'code_expired':
    case 'code_locked':
      return { tone: 'error', title: 'That code did not work', body: error.message };
    case 'unavailable':
      return { tone: 'error', title: 'Could not reach Sideout', body: error.message };
    default:
      return { tone: 'error', title: 'Something went wrong', body: error.message };
  }
}

function RetryCountdown({ retryAt }: { retryAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  if (seconds === 0) return <span>You can try again now.</span>;
  return (
    <span className="tabular">
      Try again in {seconds} second{seconds === 1 ? '' : 's'}.
    </span>
  );
}

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [codeId, setCodeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [devCode, setDevCode] = useState<{ code: string; hint: string | undefined } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(event: SyntheticEvent) {
    event.preventDefault();
    setBlocker(null);
    const normalized = normalizePhone(phoneInput);
    if (normalized === null) {
      setErrors({ phone: 'Enter a phone number: ten US digits, or international with the country code.' });
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await api<RequestData>('/api/auth/request-code', { method: 'POST', body: { phone: normalized } });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === 'validation_failed') setErrors(fieldIssues(result.error));
      else setBlocker(blockerFor(result));
      return;
    }
    setPhone(normalized);
    setCodeId(result.data.codeId);
    setDevCode(result.data.code === undefined ? null : { code: result.data.code, hint: result.data.hint });
    setCode('');
    setStep('code');
  }

  function backToPhone() {
    setStep('phone');
    setCode('');
    setBlocker(null);
    setErrors({});
  }

  async function verify(event: SyntheticEvent) {
    event.preventDefault();
    if (phone === null || codeId === null) return;
    setBlocker(null);
    if (!/^\d{6}$/.test(code)) {
      setErrors({ code: 'Enter the six digits from the text.' });
      return;
    }
    const name = displayName.trim();
    if (name !== '' && name.length < 2) {
      setErrors({ displayName: 'At least two characters.' });
      return;
    }
    setErrors({});
    setBusy(true);
    const body: Record<string, string> = { phone, codeId, code };
    if (name !== '') body['displayName'] = name;
    const result = await api<VerifyData>('/api/auth/verify', { method: 'POST', body });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === 'validation_failed') setErrors(fieldIssues(result.error));
      else setBlocker(blockerFor(result));
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <div className="space-y-4" data-testid="sign-in-form">
      {blocker === null ? null : (
        <Notice tone={blocker.tone} title={blocker.title}>
          {blocker.retryAt === undefined ? blocker.body : <RetryCountdown retryAt={blocker.retryAt} />}
        </Notice>
      )}

      {step === 'phone' ? (
        <form onSubmit={(event) => void requestCode(event)} noValidate className="surface-raised space-y-4 rounded-card p-4 md:p-5">
          <Field label="Phone number" error={errors['phone']} hint="US numbers work as ten digits; anything else in international format.">
            {({ id, describedBy, invalid }) => (
              <TextInput id={id} name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 415 555 0123" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} />
            )}
          </Field>
          <ActionButton type="submit" variant="primary" large block disabled={busy} aria-busy={busy} iconStart={<Icons.phone size={18} />}>
            {busy ? 'Sending…' : 'Text me a code'}
          </ActionButton>
        </form>
      ) : (
        <form onSubmit={(event) => void verify(event)} noValidate className="surface-raised space-y-4 rounded-card p-4 md:p-5">
          <p className="text-text-secondary">
            We texted a code to <span className="tabular text-text-primary">{phone === null ? '' : maskPhone(phone)}</span>.{' '}
            <button type="button" onClick={backToPhone} className="link-inline text-text-primary">
              Wrong number?
            </button>
          </p>
          {devCode === null ? null : (
            <Notice tone="info" title="Development build" testId="dev-code">
              <span>
                No SMS provider is wired in, so the code is shown here: <span className="tabular font-medium text-text-primary">{devCode.code}</span>
                {devCode.hint === undefined ? '' : ` ${devCode.hint}`}
              </span>
            </Notice>
          )}
          <Field label="Six-digit code" error={errors['code']} hint="Use the most recent message; an earlier code answers only to its own request.">
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={busy}
                className="tabular text-subheading tracking-[0.3em]"
              />
            )}
          </Field>
          <Field label="Your name" meta="first time only" error={errors['displayName']} hint="How you appear on pool sheets and standings. Leave blank if you already have an account.">
            {({ id, describedBy, invalid }) => <TextInput id={id} name="displayName" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} maxLength={60} />}
          </Field>
          <ActionButton type="submit" variant="primary" large block disabled={busy} aria-busy={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </ActionButton>
          <button type="button" onClick={(event) => void requestCode(event)} disabled={busy} className="target w-full type-label text-text-secondary hover:text-text-primary">
            Send a new code
          </button>
        </form>
      )}
    </div>
  );
}
