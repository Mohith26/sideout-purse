import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconcileResource } from '@purse/types';

import { InvariantPanel } from '../src/components/InvariantPanel';
import { click, mockApi } from './mock-api';

/** The live panel: every invariant listed, a failed one red, the last run time shown, a run on demand and on the timer. */
const clean: ReconcileResource = {
  ok: true,
  ranAt: '2026-09-18T12:00:00.000Z',
  durationMs: 12,
  invariants: [
    { id: 'I1', name: 'journal nets to zero per asset', ok: true, status: 'ok', detail: 'nets to zero per asset (POINTS: debits 100, credits 100)' },
    { id: 'I2', name: 'every entry balances', ok: true, status: 'ok', detail: 'every one of 3 entries balances' },
    { id: 'I3', name: 'no user wallet is negative', ok: true, status: 'ok', detail: 'none of 2 user wallets is negative' },
    { id: 'I4', name: 'settled contests have zero escrow', ok: true, status: 'ok', detail: 'ok' },
    { id: 'I5', name: 'settled payouts equal escrowed total', ok: true, status: 'ok', detail: 'ok' },
    { id: 'I6', name: 'every snapshot equals its derived balance', ok: true, status: 'ok', detail: 'no account_balance_snapshots table; balances are derived only' },
    { id: 'I7', name: 'every entry ledger link is a matching escrow entry', ok: true, status: 'ok', detail: 'ok' },
  ],
};

const broken: ReconcileResource = {
  ...clean,
  ok: false,
  ranAt: '2026-09-18T12:01:00.000Z',
  invariants: clean.invariants.map((each) => (each.id === 'I3' ? { ...each, ok: false, status: 'failed', detail: '1 user wallets are negative: acct_x=-440' } : each)),
};

describe('InvariantPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a failed invariant red with its detail, the headline red, and the last run time', () => {
    mockApi({});
    render(<InvariantPanel initial={broken} autoRefresh={false} />);
    const panel = screen.getByTestId('invariant-panel');
    expect(panel.getAttribute('data-status')).toBe('failed');
    expect(screen.getByText('1 invariant failed')).toBeTruthy();
    expect(screen.getByText(/Last run 2026-09-18 12:01:00Z in 12 ms/)).toBeTruthy();
    const rows = panel.querySelectorAll('[data-invariant]');
    expect(rows).toHaveLength(7);
    const i3 = panel.querySelector('[data-invariant="I3"]');
    expect(i3?.className).toContain('invariant--failed');
    expect(i3?.textContent).toContain('1 user wallets are negative: acct_x=-440');
    expect(i3?.textContent).toContain('FAILED');
    expect(panel.querySelector('[data-invariant="I1"]')?.className).not.toContain('invariant--failed');
    expect(panel.querySelector('[data-invariant="I1"]')?.textContent).toContain('holds');
  });

  it('runs on demand and turns green when the next report is clean', async () => {
    const { calls } = mockApi({ 'GET /reconcile': () => ({ status: 200, data: clean }) });
    render(<InvariantPanel initial={broken} autoRefresh={false} />);
    await click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(screen.getByTestId('invariant-panel').getAttribute('data-status')).toBe('ok'));
    expect(screen.getByText('All invariants hold')).toBeTruthy();
    expect(calls.filter((call) => call.path.startsWith('/reconcile'))).toHaveLength(1);
  });

  it('refreshes on the timer while live and stops when paused', async () => {
    const { calls } = mockApi({ 'GET /reconcile': () => ({ status: 200, data: broken }) });
    render(<InvariantPanel initial={clean} refreshMs={1000} />);
    expect(screen.getByText(/every 1s/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1050);
    });
    await waitFor(() => expect(screen.getByTestId('invariant-panel').getAttribute('data-status')).toBe('failed'));
    expect(calls).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(calls).toHaveLength(1);
    expect(screen.getByText('paused')).toBeTruthy();
  });

  it('shows a failed run as an error without dropping the last report', async () => {
    mockApi({ 'GET /reconcile': () => ({ status: 500, error: { type: 'internal_error', code: 'unhandled', message: 'Something went wrong' } }) });
    render(<InvariantPanel initial={clean} autoRefresh={false} />);
    await click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('The last run did not complete')).toBeTruthy();
    expect(screen.getByTestId('invariant-panel').getAttribute('data-status')).toBe('ok');
  });
});
