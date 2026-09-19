'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Card, Chip, DataTable, Money } from '@sideout/ui';
import type { ApiError, LedgerReplayResource } from '@purse/types';

import { api } from '../lib/client';
import { formatInstant, shortId } from '../lib/format';
import { ErrorNotice } from './ErrorNotice';

export function LedgerReplay({ tenantId, initial }: { tenantId: string; initial: LedgerReplayResource }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [position, setPosition] = useState(initial.position);
  const [jump, setJump] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function fetchPosition(query: URLSearchParams, mode: 'push' | 'replace' | 'pop' = 'push') {
    if (timer.current !== null) clearTimeout(timer.current);
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    setPending(true);
    setError(null);
    try {
      const res = await api.get<LedgerReplayResource>(`/tenants/${tenantId}/ledger/replay?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setError(res.error);
        setPosition(snapshot.position);
        return;
      }
      setSnapshot(res.data);
      setPosition(res.data.position);
      const url = new URL(window.location.href);
      url.search = '';
      if (res.data.entry !== null) url.searchParams.set('at', res.data.entry.id);
      const after = query.get('after');
      if (after !== null) url.searchParams.set('after', after);
      if (mode === 'push') window.history.pushState(null, '', url);
      if (mode === 'replace') window.history.replaceState(null, '', url);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError({ type: 'internal_error', code: 'network', message: caught instanceof Error ? caught.message : 'Replay could not be loaded' });
        setPosition(snapshot.position);
      }
    } finally {
      if (flight.current === controller) setPending(false);
    }
  }

  // The ref lets back/forward use the latest snapshot without re-registering the listener.
  const fetchRef = useRef(fetchPosition);
  useEffect(() => { fetchRef.current = fetchPosition; });
  useEffect(() => {
    const onPop = () => { void fetchRef.current(new URLSearchParams(window.location.search), 'pop'); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      flight.current?.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('at') && initial.entry !== null) {
      url.searchParams.delete('position');
      url.searchParams.set('at', initial.entry.id);
      window.history.replaceState(null, '', url);
    }
  }, [initial.entry]);

  function move(next: number) {
    flight.current?.abort();
    flight.current = null;
    if (timer.current !== null) clearTimeout(timer.current);
    setPosition(next);
    setPending(true);
    timer.current = setTimeout(() => { void fetchPosition(new URLSearchParams({ position: String(next) })); }, 150);
  }

  const entry = snapshot.entry;
  const balanced = snapshot.totals.every((total) => total.net === '0');
  const entryBalanced = snapshot.lines.length >= 2 && snapshot.entryTotals.length === 1 && snapshot.entryTotals.every((t) => t.debits === t.credits);
  return (
    <div className="stack">
      <Card title="Journal timeline">
        {snapshot.total === 0 ? <p>No journal entries yet. Accounts have zero balances.</p> : (
          <>
            <label htmlFor="replay-position">Journal position</label>
            <input id="replay-position" type="range" min={1} max={snapshot.total} step={1} value={position}
              aria-valuetext={`Entry ${position} of ${snapshot.total}`} aria-describedby="replay-order"
              onChange={(event) => move(Number(event.target.value))} style={{ width: '100%', minHeight: 44 }} />
            <div className="so-actions">
              <Button small disabled={position <= 1} onClick={() => move(position - 1)}>Previous entry</Button>
              <Button small disabled={position >= snapshot.total} onClick={() => move(position + 1)}>Next entry</Button>
              <span role="status" aria-live="polite">{pending ? `Loading entry ${position}…` : `Entry ${snapshot.position} of ${snapshot.total}`}</span>
            </div>
          </>
        )}
        <p id="replay-order" className="label">Posting time, then entry ID. Use arrow keys to step, Home for first, End for last. Balances include the selected entry.</p>
        <form className="so-actions" onSubmit={(event) => { event.preventDefault(); void fetchPosition(new URLSearchParams({ at: jump.trim() })); }}>
          <label htmlFor="replay-jump">Entry ID</label>
          <input id="replay-jump" className="so-input" value={jump} onChange={(event) => setJump(event.target.value)} required pattern="je_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" placeholder="je_…" />
          <Button small type="submit">Jump to entry</Button>
        </form>
        {error === null ? null : <ErrorNotice error={error} title="Replay could not be loaded; the previous view is shown" />}
      </Card>
      <div className="stack" aria-busy={pending} style={{ opacity: pending ? 0.6 : 1 }}>
        <Card title="Conservation at this entry">
          <div data-testid="replay-conservation" data-status={balanced ? 'ok' : 'failed'}>
            <Chip tone={balanced ? 'surf' : 'fault'}>{balanced ? 'Conservation holds' : 'Conservation FAILED'}</Chip>
          </div>
          <p className="label">All accounts, including other pages. Credit-normal balances minus debit-normal balances must net to zero per asset. This is the historical conservation check; the Invariants screen runs the full current ledger checks.</p>
          <DataTable caption="Replay asset totals" rows={snapshot.totals} rowKey={(t) => t.asset} columns={[
            { key: 'asset', header: 'Asset', render: (t) => t.asset },
            { key: 'net', header: 'Net balance', numeric: true, render: (t) => <Money amount={t.net} /> },
          ]} />
        </Card>
        {entry === null ? null : <Card title={`${entry.kind} · ${formatInstant(entry.postedAt)}`}>
          <Link className="so-link so-mono" href={`/entries/${entry.id}`}>{entry.id}</Link>
          <p>{entry.description}</p>
          <div data-testid="replay-entry-balanced"><Chip tone={entryBalanced ? 'surf' : 'fault'}>{entryBalanced ? 'Entry balances' : 'Entry FAILED'}</Chip></div>
          <DataTable caption="Replay journal lines" rows={snapshot.lines} rowKey={(line) => line.id} columns={[
            { key: 'account', header: 'Account', render: (line) => <Link className="so-link so-mono" href={`/accounts/${line.accountId}`}>{shortId(line.accountId)}</Link> },
            { key: 'direction', header: 'Direction', render: (line) => line.direction },
            { key: 'amount', header: 'Amount', numeric: true, render: (line) => <Money amount={line.amount} asset={line.asset} /> },
          ]} />
          <DataTable caption="Replay entry totals" rows={snapshot.entryTotals} rowKey={(t) => t.asset} columns={[
            { key: 'asset', header: 'Asset', render: (t) => t.asset },
            { key: 'debits', header: 'Debits', numeric: true, render: (t) => <Money amount={t.debits} /> },
            { key: 'credits', header: 'Credits', numeric: true, render: (t) => <Money amount={t.credits} /> },
          ]} />
        </Card>}
        <Card title="Account balances">
          <p className="label">Showing {snapshot.accounts.length} of {snapshot.accountCount} accounts (up to {snapshot.accountLimit} per page). Names and ownership are current; balances come only from the journal at this entry. Highlighted accounts changed from the immediately preceding entry, including when stepping backwards.</p>
          <p role="status">{snapshot.changedAccountIds.length} accounts changed at this entry.</p>
          <div data-testid="replay-balances">
            <DataTable caption="Replay account balances" rows={snapshot.accounts} rowKey={(a) => a.id} columns={[
              { key: 'account', header: 'Account', render: (a) => <><Link className="so-link" href={`/accounts/${a.id}`}>{a.label}</Link><div className="label so-mono">{shortId(a.id)} · {a.kind}</div></> },
              { key: 'balance', header: 'Balance', numeric: true, render: (a) => <span className={a.delta === '0' ? '' : 'replay-changed'}><Money amount={a.balance} asset={a.asset} /></span> },
              { key: 'delta', header: 'Change at entry', numeric: true, render: (a) => a.delta === '0' ? '—' : <><Chip tone="surf">Changed</Chip> <Money amount={a.delta} signed /></> },
            ]} />
          </div>
          <div className="so-actions">
            <Button small disabled={pending} onClick={() => { void fetchPosition(new URLSearchParams(entry === null ? {} : { at: entry.id })); }}>First account page</Button>
            <Button small disabled={pending || snapshot.nextAccountCursor === null} onClick={() => {
              if (snapshot.nextAccountCursor !== null) void fetchPosition(new URLSearchParams({ ...(entry === null ? {} : { at: entry.id }), after: snapshot.nextAccountCursor }));
            }}>More accounts</Button>
          </div>
        </Card>
        <Card title="Contest escrows touched so far">
          <DataTable caption="Replay contest escrows" rows={snapshot.escrows} rowKey={(a) => a.id} empty="No contest escrow activity at this position." columns={[
            { key: 'contest', header: 'Contest', render: (a) => <Link className="so-link" href={`/tenants/${tenantId}/contests/${a.ownerRef}`}>{a.label}</Link> },
            { key: 'balance', header: 'Escrow at entry', numeric: true, render: (a) => <Money amount={a.balance} asset={a.asset} /> },
          ]} />
          <p className="label">Every escrow with activity up to this entry, including zero balances. Historical balances do not imply a historical contest state.</p>
        </Card>
      </div>
    </div>
  );
}
