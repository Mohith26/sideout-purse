'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Field, Notice, Textarea } from '@sideout/ui';
import type { ApiError, RulesetResource } from '@purse/types';

import { ErrorNotice } from '../../../../components/ErrorNotice';
import { api } from '../../../../lib/client';

/** The next version number in the current month, or `.1` of a new month, given the versions that exist. */
export function nextVersion(existing: readonly string[], now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const prefix = `${year}.${month}.`;
  const taken = existing.filter((each) => each.startsWith(prefix)).map((each) => Number(each.slice(prefix.length))).filter((n) => Number.isInteger(n));
  return `${prefix}${taken.length === 0 ? 1 : Math.max(...taken) + 1}`;
}

export function NewRuleset({ initialBody, existing, admin }: { initialBody: Record<string, unknown> | null; existing: readonly string[]; admin: boolean }) {
  const router = useRouter();
  const version = nextVersion(existing, new Date());
  const [text, setText] = useState(JSON.stringify({ ...(initialBody ?? {}), version }, null, 2));
  const [activate, setActivate] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function publish() {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (caught) {
      setParseError(caught instanceof Error ? caught.message : 'Not valid JSON');
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      setParseError('The ruleset must be a JSON object');
      return;
    }
    setParseError(null);
    setBusy(true);
    setError(null);
    const res = await api.post<RulesetResource>('/rulesets', { body, activate });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.push(`/rulesets/${res.data.version}`);
    router.refresh();
  }

  return (
    <Card title={`Version ${version}`}>
      {!admin ? <Notice title="Read only">Only an admin can publish a version.</Notice> : null}
      <Field id="ruleset-body" label="Body (JSON)" hint="Validated against the ruleset schema on submit; every issue is reported with its path.">
        <Textarea id="ruleset-body" value={text} onChange={(event) => setText(event.target.value)} rows={28} spellCheck={false} disabled={!admin} />
      </Field>
      {parseError === null ? null : <Notice tone="error" title="Not valid JSON">{parseError}</Notice>}
      {error === null ? null : <ErrorNotice error={error} />}
      <label className="row" style={{ minHeight: 'var(--target-min)' }}>
        <input type="checkbox" checked={activate} onChange={(event) => setActivate(event.target.checked)} disabled={!admin} />
        <span>Activate on publish</span>
      </label>
      <div className="so-actions">
        <Button variant="primary" disabled={busy || !admin} onClick={publish}>
          {activate ? 'Publish and activate' : 'Publish version'}
        </Button>
      </div>
    </Card>
  );
}
