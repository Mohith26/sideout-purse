'use client';

import { useState, type FormEvent } from 'react';
import type { ApiError, EmbedUserState } from '@purse/types';

import { toApiError, type EmbedApi } from '../embed/api';
import { Button, ErrorNotice, Field, Notice } from '../components/ui';

/**
 * Phone plus one-time code (spec 4.8): the Purse identity session for a visitor who
 * arrived without an embed token. The dev SMS sender echoes the code back so a local
 * demo needs no phone; production's sender does not.
 */
export function Signin({ api, state, onSignedIn, onError }: { api: EmbedApi; state: EmbedUserState; onSignedIn: (state: EmbedUserState) => void; onError: (error: ApiError) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<{ devCode: string | null } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();

  if (state.authenticated) {
    return (
      <div className="card">
        <Notice tone="positive" title={`Signed in as ${state.user.displayName ?? state.user.externalId}`} />
        <div className="actions">
          <Button onClick={() => onSignedIn(state)}>Continue</Button>
        </div>
      </div>
    );
  }

  const start = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const started = await api.startSignin(phone.trim());
      setSent({ devCode: started.devCode });
    } catch (caught) {
      const failure = toApiError(caught);
      setError(failure);
      onError(failure);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await api.verifySignin(phone.trim(), code.trim()));
    } catch (caught) {
      const failure = toApiError(caught);
      setError(failure);
      onError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={sent === undefined ? start : verify}>
      <Field id="phone" label="Phone" hint="The number on your account, in international format.">
        <input id="phone" className="field__input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 512 555 0101" value={phone} onChange={(event) => setPhone(event.target.value.replace(/[\s()-]/g, ''))} disabled={sent !== undefined || busy} required />
      </Field>
      {sent === undefined ? null : (
        <Field id="code" label="Code" hint={sent.devCode === null ? 'Six digits, sent by text. It expires in ten minutes.' : `Development: your code is ${sent.devCode}.`}>
          <input id="code" className="field__input" inputMode="numeric" autoComplete="one-time-code" pattern="\\d{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} disabled={busy} required />
        </Field>
      )}
      {error === undefined ? null : <ErrorNotice error={error} />}
      <div className="actions">
        <Button type="submit" disabled={busy}>
          {sent === undefined ? 'Send code' : 'Sign in'}
        </Button>
        {sent === undefined ? null : (
          <Button variant="secondary" onClick={() => { setSent(undefined); setCode(''); setError(undefined); }} disabled={busy}>
            Use another number
          </Button>
        )}
      </div>
    </form>
  );
}
