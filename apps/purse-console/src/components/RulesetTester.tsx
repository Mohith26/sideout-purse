'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Chip, Field, Input, KeyValue, Select } from '@sideout/ui';
import { RESTRICTION_KINDS, VERIFICATION_STATES, type ApiError, type Asset, type RestrictionKind, type RulesetTestInput, type RulesetTestResource, type VerificationState } from '@purse/types';

import { api } from '../lib/client';
import { titleCase } from '../lib/format';
import { ErrorNotice } from './ErrorNotice';

/**
 * The tester form (spec 4.10): sample user fields, the contest's asset and amount, the
 * wallet balance and the velocity, run through `POST /console/rulesets/evaluate`, which
 * calls the pure evaluator and persists nothing. Money is typed as decimal strings and sent
 * as such: never a float.
 */
export type RulesetTesterProps = {
  versions: Array<{ version: string; active: boolean }>;
  initialVersion?: string | undefined;
  /** Injected for tests; the console API by default. */
  evaluate?: (input: RulesetTestInput) => Promise<{ ok: true; data: RulesetTestResource } | { ok: false; error: ApiError }>;
};

const AMOUNT = /^(0|[1-9][0-9]*)$/;

export function RulesetTester({ versions, initialVersion, evaluate }: RulesetTesterProps) {
  const [version, setVersion] = useState(initialVersion ?? versions.find((each) => each.active)?.version ?? '');
  const [dateOfBirth, setDateOfBirth] = useState('1990-01-01');
  const [verification, setVerification] = useState<VerificationState>('verified');
  const [region, setRegion] = useState('US-TX');
  const [restriction, setRestriction] = useState<RestrictionKind | ''>('');
  const [asset, setAsset] = useState<Asset>('POINTS');
  const [entryAmount, setEntryAmount] = useState('100');
  const [balance, setBalance] = useState('1000');
  const [last24h, setLast24h] = useState('0');
  const [last7d, setLast7d] = useState('0');
  const [result, setResult] = useState<RulesetTestResource | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const invalidAmounts = [entryAmount, balance, last24h, last7d].some((each) => !AMOUNT.test(each));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalidAmounts) return;
    setBusy(true);
    setError(null);
    const now = new Date().toISOString();
    const input: RulesetTestInput = {
      ...(version === '' ? {} : { rulesetVersion: version }),
      user: {
        dateOfBirth: dateOfBirth === '' ? null : dateOfBirth,
        verificationState: verification,
        restrictions: restriction === '' ? [] : [{ kind: restriction, startsAt: now, endsAt: null }],
        region: region.trim() === '' ? null : region.trim().toUpperCase(),
      },
      contest: { asset, entryAmount, kind: 'tournament' },
      wallet: { balance },
      velocity: { enteredLast24h: last24h, enteredLast7d: last7d },
      asOf: now,
    };
    const res = evaluate === undefined ? await api.post<RulesetTestResource>('/rulesets/evaluate', input) : await evaluate(input);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      setResult(null);
      return;
    }
    setResult(res.data);
  }

  return (
    <div className="grid grid--two">
      <Card title="Sample">
        <form className="form" onSubmit={submit}>
          <Field id="t-version" label="Ruleset version">
            <Select id="t-version" value={version} onChange={(event) => setVersion(event.target.value)}>
              {versions.map((each) => (
                <option key={each.version} value={each.version}>
                  {each.version}
                  {each.active ? ' (active)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="t-dob" label="Date of birth" hint="Blank for a user who has not supplied one.">
            <Input id="t-dob" type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} />
          </Field>
          <Field id="t-verification" label="Verification state">
            <Select id="t-verification" value={verification} onChange={(event) => setVerification(event.target.value as VerificationState)}>
              {VERIFICATION_STATES.map((each) => (
                <option key={each} value={each}>
                  {each}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="t-region" label="Region" hint="ISO 3166, such as US-TX; blank for unknown.">
            <Input id="t-region" value={region} onChange={(event) => setRegion(event.target.value)} maxLength={6} />
          </Field>
          <Field id="t-restriction" label="Restriction in force">
            <Select id="t-restriction" value={restriction} onChange={(event) => setRestriction(event.target.value as RestrictionKind | '')}>
              <option value="">none</option>
              {RESTRICTION_KINDS.map((each) => (
                <option key={each} value={each}>
                  {titleCase(each)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="t-asset" label="Contest asset">
            <Select id="t-asset" value={asset} onChange={(event) => setAsset(event.target.value as Asset)}>
              <option value="POINTS">POINTS</option>
              <option value="CREDIT">CREDIT</option>
            </Select>
          </Field>
          <Field id="t-amount" label="Entry amount" hint="Minor units, a whole number.">
            <Input id="t-amount" inputMode="numeric" value={entryAmount} onChange={(event) => setEntryAmount(event.target.value)} aria-invalid={!AMOUNT.test(entryAmount)} />
          </Field>
          <Field id="t-balance" label="Wallet balance">
            <Input id="t-balance" inputMode="numeric" value={balance} onChange={(event) => setBalance(event.target.value)} aria-invalid={!AMOUNT.test(balance)} />
          </Field>
          <Field id="t-24h" label="Entered last 24h">
            <Input id="t-24h" inputMode="numeric" value={last24h} onChange={(event) => setLast24h(event.target.value)} aria-invalid={!AMOUNT.test(last24h)} />
          </Field>
          <Field id="t-7d" label="Entered last 7d">
            <Input id="t-7d" inputMode="numeric" value={last7d} onChange={(event) => setLast7d(event.target.value)} aria-invalid={!AMOUNT.test(last7d)} />
          </Field>
          <div className="form__wide so-actions">
            <Button type="submit" variant="primary" disabled={busy || invalidAmounts}>
              {busy ? 'Evaluating…' : 'What would this decide?'}
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Decision">
        {error === null ? null : <ErrorNotice error={error} />}
        {result === null ? (
          <p className="console__lede">Nothing evaluated yet.</p>
        ) : (
          <div className="stack" data-testid="tester-decision" data-allowed={result.decision.allowed ? 'true' : 'false'}>
            <div className="so-stat">
              <span className={`so-stat__value ${result.decision.allowed ? 'so-stat__value--surf' : 'so-stat__value--fault'}`}>{result.decision.allowed ? 'Allowed' : 'Not eligible'}</span>
              <span className="label">
                under {result.rulesetVersion} as of {result.asOf}
              </span>
            </div>
            {result.decision.allowed ? null : (
              <KeyValue
                items={[
                  {
                    key: 'Reasons',
                    value: (
                      <span className="so-actions">
                        {result.decision.reasons.map((reason) => (
                          <Chip key={reason} tone="fault">
                            {titleCase(reason)}
                          </Chip>
                        ))}
                      </span>
                    ),
                  },
                  { key: 'Required action', value: result.decision.requiredAction === undefined ? 'none (terminal)' : titleCase(result.decision.requiredAction) },
                ]}
              />
            )}
            <pre className="pre">{JSON.stringify(result.decision, null, 2)}</pre>
          </div>
        )}
      </Card>
    </div>
  );
}
