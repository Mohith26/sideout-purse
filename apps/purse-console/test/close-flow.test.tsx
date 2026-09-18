import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ConsoleSettlementResource, PreviewResource } from '@purse/types';

import { CloseFlow } from '../src/components/CloseFlow';
import { click, mockApi } from './mock-api';

/**
 * The two-step commit (spec 4.7, 4.10). Step one shows the preview's placements, payouts
 * and hash exactly as received; step two posts that hash and nothing else, under one
 * idempotency key; a refusal is rendered with its sealed type and code and a stale hash
 * offers a fresh preview.
 */
const HASH = 'a'.repeat(64);

const preview: PreviewResource = {
  contestId: 'cnt_1',
  state: 'awaiting_settlement',
  escrowTotal: '400',
  entries: [
    { userId: 'usr_a', participantId: 'ent_a', participantState: 'entered', score: 30, seed: null, attemptFinished: true },
    { userId: 'usr_b', participantId: 'ent_b', participantState: 'entered', score: 20, seed: null, attemptFinished: true },
  ],
  payouts: [
    { userId: 'usr_a', placement: 1, payout: '240' },
    { userId: 'usr_b', placement: 2, payout: '160' },
  ],
  payoutHash: HASH,
};

const settlement: ConsoleSettlementResource = {
  contest: {
    id: 'cnt_1',
    externalId: 'x',
    kind: 'tournament',
    title: 't',
    asset: 'POINTS',
    entryAmount: '200',
    maxParticipants: null,
    prizeStructure: { type: 'percentage_split', percentages: [60, 40] },
    tieBreak: 'split_evenly',
    settlementPolicy: 'operator_close',
    eligibilityRulesetVersion: null,
    state: 'settled',
    opensAt: null,
    locksAt: null,
    escrowAccountId: 'acct_e',
    escrowBalance: '0',
    participantCount: 2,
    settledAt: '2026-09-18T12:00:00.000Z',
    createdAt: '2026-09-18T11:00:00.000Z',
    updatedAt: '2026-09-18T12:00:00.000Z',
  },
  results: [
    { id: 'res_1', contestId: 'cnt_1', userId: 'usr_a', placement: 1, score: 30, payoutAmount: '240', payoutJournalEntryId: 'je_s', computedAt: '2026-09-18T12:00:00.000Z' },
    { id: 'res_2', contestId: 'cnt_1', userId: 'usr_b', placement: 2, score: 20, payoutAmount: '160', payoutJournalEntryId: 'je_s', computedAt: '2026-09-18T12:00:00.000Z' },
  ],
  payoutHash: HASH,
  journalEntryId: 'je_s',
  replayed: false,
};

describe('CloseFlow', () => {
  it('step one freezes the preview on screen; step two posts exactly that hash under one idempotency key', async () => {
    const { calls } = mockApi({
      'GET /tenants/tnt_1/contests/cnt_1/preview': () => ({ status: 200, data: preview }),
      'POST /tenants/tnt_1/contests/cnt_1/close': () => ({ status: 200, data: settlement }),
    });
    render(<CloseFlow tenantId="tnt_1" contestId="cnt_1" asset="POINTS" names={{ usr_a: 'Ana', usr_b: 'Marcus' }} onSettled={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId('payout-hash').textContent).toBe(HASH));
    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.getByText('equals escrow')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Frozen placements and payouts' });
    expect(table.textContent).toContain('240');
    expect(table.textContent).toContain('160');
    // Nothing has been posted yet, and the confirm button is not on screen.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Confirm close/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to confirm' }));
    expect(screen.getByText('This settles the contest')).toBeTruthy();
    // The hash on screen is still the one received.
    expect(screen.getByTestId('payout-hash').textContent).toBe(HASH);

    await click(screen.getByRole('button', { name: 'Confirm close with this hash' }));
    await waitFor(() => expect(screen.getByText('Settled')).toBeTruthy());
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ payoutHash: HASH });
    expect(posts[0]?.headers['idempotency-key']).toMatch(/^console-/);
    expect(posts[0]?.headers['content-type']).toBe('application/json');
    expect(screen.getByText(/2 results recorded/)).toBeTruthy();
  });

  it('renders a refusal with its sealed type and code, and a stale hash offers a fresh preview', async () => {
    let previews = 0;
    const { calls } = mockApi({
      'GET /tenants/tnt_1/contests/cnt_1/preview': () => {
        previews += 1;
        return { status: 200, data: { ...preview, payoutHash: previews === 1 ? HASH : 'b'.repeat(64) } };
      },
      'POST /tenants/tnt_1/contests/cnt_1/close': () => ({ status: 409, error: { type: 'conflict', code: 'preview_hash_mismatch', message: 'The preview is stale; fetch it again', detail: { expected: 'b'.repeat(64) } } }),
    });
    render(<CloseFlow tenantId="tnt_1" contestId="cnt_1" asset="POINTS" onSettled={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('payout-hash').textContent).toBe(HASH));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to confirm' }));
    await click(screen.getByRole('button', { name: 'Confirm close with this hash' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('conflict/preview_hash_mismatch');
    expect(screen.getByText('The preview is stale')).toBeTruthy();
    const firstKey = calls.find((call) => call.method === 'POST')?.headers['idempotency-key'];

    // A fresh preview carries the new hash, and a new confirm uses a new key.
    await click(screen.getByRole('button', { name: 'Fetch a fresh preview' }));
    await waitFor(() => expect(screen.getByTestId('payout-hash').textContent).toBe('b'.repeat(64)));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to confirm' }));
    await click(screen.getByRole('button', { name: 'Confirm close with this hash' }));
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({ payoutHash: 'b'.repeat(64) });
    expect(posts[1]?.headers['idempotency-key']).not.toBe(firstKey);
  });

  it('renders an invalid_state refusal in place when the contest is not awaiting settlement', async () => {
    mockApi({
      'GET /tenants/tnt_1/contests/cnt_1/preview': () => ({ status: 200, data: preview }),
      'POST /tenants/tnt_1/contests/cnt_1/close': () => ({ status: 409, error: { type: 'invalid_state', code: 'already_settled', message: 'Contest cnt_1 was already settled' } }),
    });
    render(<CloseFlow tenantId="tnt_1" contestId="cnt_1" asset="POINTS" onSettled={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('payout-hash')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Continue to confirm' }));
    await click(screen.getByRole('button', { name: 'Confirm close with this hash' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('invalid_state/already_settled'));
    expect(screen.getByText('Not in that state')).toBeTruthy();
  });
});
