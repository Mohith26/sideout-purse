import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerReplayResource } from '@purse/types';

import { LedgerReplay } from '../src/components/LedgerReplay';
import { click, mockApi } from './mock-api';

const firstId = 'je_00000000-0000-7000-8000-000000000001';
const secondId = 'je_00000000-0000-7000-8000-000000000002';
const initial: LedgerReplayResource = {
  position: 1, total: 3, accountCount: 1, accountLimit: 200, nextAccountCursor: null,
  entry: { id: firstId, tenantId: 'tnt_test', kind: 'issue', description: 'Issue points', idempotencyKey: 'key', contestId: null, reversesEntryId: null, postedAt: '2025-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z' },
  accounts: [{ id: 'acct_test', kind: 'user_wallet', label: 'Player', asset: 'POINTS', normalSide: 'credit', ownerRef: 'usr_test', balance: '10', delta: '10', lineCount: 1 }],
  changedAccountIds: ['acct_test'], escrows: [], lines: [], totals: [{ asset: 'POINTS', net: '0' }], entryTotals: [],
};
const next: LedgerReplayResource = { ...initial, position: 2, entry: initial.entry === null ? null : { ...initial.entry, id: secondId } };

describe('LedgerReplay navigation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, '', '/tenants/tnt_test/ledger/replay');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('preserves the view and shareable position when a request fails', async () => {
    mockApi({ 'GET /tenants/tnt_test/ledger/replay': () => ({ status: 400, error: { type: 'invalid_request', code: 'entry_not_found', message: 'No entry' } }) });
    render(<LedgerReplay tenantId="tnt_test" initial={initial} />);
    expect(new URLSearchParams(window.location.search).get('at')).toBe(firstId);
    await click(screen.getByRole('button', { name: 'Next entry' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('previous view'));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Entry 1 of 3');
    expect(window.location.search).toContain(firstId);
    expect(screen.getByTestId('replay-balances').textContent).toContain('10');
  });

  it('ignores a stale response after a newer slider request and restores back navigation', async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { resolveOld = resolve; });
      return new Response(JSON.stringify({ data: next }), { status: 200 });
    }));
    render(<LedgerReplay tenantId="tnt_test" initial={initial} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '3' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.change(slider, { target: { value: '2' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await waitFor(() => expect(window.location.search).toContain(secondId));
    await act(async () => {
      resolveOld?.(new Response(JSON.stringify({ data: { ...initial, position: 3 } }), { status: 200 }));
      await Promise.resolve();
    });
    expect(slider.getAttribute('aria-valuetext')).toBe('Entry 2 of 3');
    expect(window.location.search).toContain(secondId);
    mockApi({ 'GET /tenants/tnt_test/ledger/replay': () => ({ status: 200, data: initial }) });
    window.history.replaceState(null, '', `?at=${firstId}`);
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); await Promise.resolve(); });
    await waitFor(() => expect(slider.getAttribute('aria-valuetext')).toBe('Entry 1 of 3'));
  });
});
