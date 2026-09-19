// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportPublicJwk, generateAttestationKeyPair, jwkThumbprint, verifyAttestation } from '@purse/types';

import { ScoreSubmitSheet, shouldQueue, type SubmitResponse } from '../../src/components/consensus/ScoreSubmitSheet';
import { attestationPayload, type SubmittedAttestation } from '../../src/domain/attestation';
import type { SubmittedSet } from '../../src/domain/consensus';
import type { ApiResult } from '../../src/lib/api-client';
import { MemoryKeyStore, useDeviceKeyStoreForTests } from '../../src/lib/attestation/device';
import { useOutboxStoreForTests } from '../../src/lib/offline/client';
import { MemoryOutbox } from '../../src/lib/offline/outbox';
import { interact } from './act';

/**
 * The score sheet's three post-submit states (spec 5.3, "Match"): waiting on the
 * opponent, agreed with one decisive check, and a neutral side-by-side disagreement with
 * the differing set marked; plus the honest queued state when the phone has no
 * connection. The sheet is a native dialog; jsdom lacks `showModal`, so it is stubbed.
 */
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const us = { id: 'tm_us', name: 'Farouk / Vries' };
const them = { id: 'tm_them', name: 'El-Amin / Petrov' };

function ok(data: SubmitResponse): ApiResult<SubmitResponse> {
  return { ok: true, data, status: 201, retryAfterMs: null };
}

function response(outcome: SubmitResponse['outcome'], extra: Partial<SubmitResponse> = {}): SubmitResponse {
  return {
    outcome,
    replaced: false,
    perspective: 'b',
    match: { winnerTeamId: null, teamAId: them.id, teamBId: us.id, sets: [] },
    consensus: { state: outcome, disputedReason: null, live: [], differences: [] },
    purse: null,
    ...extra,
  };
}

/** Enter 21–18, 21–16 from our side. */
function enterSweep(sheet: HTMLElement) {
  const set = (label: string, value: string) => {
    const input = within(sheet).getByRole('textbox', { name: `${label} points` });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
  };
  set('Your team, set 1', '21');
  set(`${them.name}, set 1`, '18');
  set('Your team, set 2', '21');
  set(`${them.name}, set 2`, '16');
}

async function openSheet(submit: (matchId: string, sets: SubmittedSet[], attestation: SubmittedAttestation | null) => Promise<ApiResult<SubmitResponse>>, opponentSubmitted = false, signing: { tournamentId: string; liveKeyIds: string[] } | null = null) {
  render(<ScoreSubmitSheet matchId="mch_1" bestOf={3} us={us} them={them} perspective="b" existing={null} opponentSubmitted={opponentSubmitted} submit={submit} signing={signing} />);
  fireEvent.click(screen.getByRole('button', { name: opponentSubmitted ? 'Confirm the result' : 'Submit score' }));
  const sheet = await screen.findByTestId('score-sheet');
  return sheet;
}

beforeEach(() => {
  refresh.mockReset();
  useOutboxStoreForTests(new MemoryOutbox());
  useDeviceKeyStoreForTests(new MemoryKeyStore());
});
afterEach(cleanup);

describe('ScoreSubmitSheet', () => {
  it('judges legality live and only enables submit for a legal scoreline, sent with our points first', async () => {
    const submit = vi.fn().mockResolvedValue(ok(response('awaiting_second')));
    const sheet = await openSheet(submit);
    const button = within(sheet).getByRole<HTMLButtonElement>('button', { name: 'Submit scoreline' });
    expect(button.disabled).toBe(true);
    enterSweep(sheet);
    expect(within(sheet).getByTestId('match-verdict').textContent).toBe('Valid result: Your team win 2–0 in sets.');
    expect(button.disabled).toBe(false);
    await interact(() => fireEvent.click(button));
    expect(submit).toHaveBeenCalledWith(
      'mch_1',
      [
        { setNumber: 1, usPoints: 21, themPoints: 18 },
        { setNumber: 2, usPoints: 21, themPoints: 16 },
      ],
      null,
    );
  });

  it('first submitter: waits on the opponent, showing the scoreline in match orientation', async () => {
    const sheet = await openSheet(vi.fn().mockResolvedValue(ok(response('awaiting_second'))));
    enterSweep(sheet);
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Submit scoreline' })));
    expect(await within(sheet).findByRole('heading', { name: `Waiting on ${them.name}` })).toBeTruthy();
    const table = within(sheet).getByRole('group', { name: 'Sets' });
    // We are team B: the table reads team A first, so our 21 lands in the second row.
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain(them.name);
    expect(rows[0]?.textContent).toContain('18');
    expect(rows[1]?.textContent).toContain('21');
  });

  it('second submitter, agreeing: one decisive surf check and Final', async () => {
    const agreed = response('agreed', { match: { winnerTeamId: us.id, teamAId: them.id, teamBId: us.id, sets: [{ setNumber: 1, teamAPoints: 18, teamBPoints: 21 }, { setNumber: 2, teamAPoints: 16, teamBPoints: 21 }] } });
    const sheet = await openSheet(vi.fn().mockResolvedValue(ok(agreed)), true);
    enterSweep(sheet);
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Submit scoreline' })));
    expect(await within(sheet).findByRole('heading', { name: 'Final' })).toBeTruthy();
    const check = within(sheet).getByTestId('confirm-check');
    expect(check.className).toContain('confirm-enter');
    expect(within(sheet).getByText(/Both teams agree\. The match is final; your team wins\./)).toBeTruthy();
  });

  it('second submitter, differing: a neutral side-by-side view with the differing set marked and no blame', async () => {
    const disputed = response('disputed', {
      consensus: {
        state: 'disputed',
        disputedReason: 'Set 2 differs',
        live: [
          { teamId: them.id, sets: [{ setNumber: 1, teamAPoints: 18, teamBPoints: 21 }, { setNumber: 2, teamAPoints: 19, teamBPoints: 21 }] },
          { teamId: us.id, sets: [{ setNumber: 1, teamAPoints: 18, teamBPoints: 21 }, { setNumber: 2, teamAPoints: 16, teamBPoints: 21 }] },
        ],
        differences: [{ setNumber: 2 }],
      },
    });
    const sheet = await openSheet(vi.fn().mockResolvedValue(ok(disputed)), true);
    enterSweep(sheet);
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Submit scoreline' })));
    expect(await within(sheet).findByRole('heading', { name: 'Scorelines differ' })).toBeTruthy();
    const compare = within(sheet).getByTestId('scoreline-compare');
    const differing = compare.querySelectorAll('[data-differs="true"]');
    expect(differing).toHaveLength(1);
    expect(differing[0]?.textContent).toContain('Set 2');
    expect(sheet.textContent).not.toMatch(/wrong|lied|cheat|blame/i);
    expect(sheet.textContent).toContain('The organizer will settle it with both teams');
  });

  it('with no answer from the server the scoreline is queued on the phone, not lost', async () => {
    const transport: ApiResult<SubmitResponse> = { ok: false, error: { type: 'internal_error', code: 'unavailable', message: 'Could not reach Sideout.' }, status: 0, retryAfterMs: null };
    expect(shouldQueue(transport)).toBe(true);
    expect(shouldQueue({ ok: false, error: { type: 'invalid_request', code: 'illegal_scoreline', message: 'no' }, status: 400, retryAfterMs: null })).toBe(false);
    const store = new MemoryOutbox();
    useOutboxStoreForTests(store);
    const sheet = await openSheet(vi.fn().mockResolvedValue(transport));
    enterSweep(sheet);
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Submit scoreline' })));
    expect(await within(sheet).findByRole('heading', { name: 'Saved on this phone' })).toBeTruthy();
    expect(within(sheet).getByTestId('queued-notice').textContent).toContain('will be sent, with the same checks');
    await waitFor(async () => expect(await store.list()).toHaveLength(1));
    const [item] = await store.list();
    expect(item?.path).toBe('/api/matches/mch_1/scores');
    expect(item?.body.sets[0]).toEqual({ setNumber: 1, usPoints: 21, themPoints: 18 });
  });

  it('signs the scoreline on the phone when this phone is checked in, and says so; an unchecked phone sends unsigned', async () => {
    const pair = await generateAttestationKeyPair();
    const publicKey = await exportPublicJwk(pair.publicKey);
    const keyId = await jwkThumbprint(publicKey);
    const store = new MemoryKeyStore();
    await store.write({ id: 'current', keyId, publicKey, privateKey: pair.privateKey });
    useDeviceKeyStoreForTests(store);
    const submit = vi.fn().mockResolvedValue(ok(response('awaiting_second')));
    const sheet = await openSheet(submit, false, { tournamentId: 'trn_1', liveKeyIds: [keyId] });
    expect((await within(sheet).findByTestId('signing-note')).getAttribute('data-signer')).toBe('checked_in');
    enterSweep(sheet);
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Submit scoreline' })));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const attestation = submit.mock.calls[0]?.[2] as SubmittedAttestation;
    expect(attestation).toMatchObject({ keyId, algorithm: 'ES256' });
    // Signed over the match-oriented sets (we are team B: our 21–18 is team A's 18–21), bound to the tournament, match and team.
    const payload = attestationPayload({
      keyId,
      timestamp: attestation.timestamp,
      tournamentId: 'trn_1',
      matchId: 'mch_1',
      teamId: us.id,
      sets: [
        { setNumber: 1, teamAPoints: 18, teamBPoints: 21 },
        { setNumber: 2, teamAPoints: 16, teamBPoints: 21 },
      ],
    });
    expect(await verifyAttestation(publicKey, payload, attestation.signature)).toBe(true);
    cleanup();

    // The same phone, not checked in for this team: unsigned, and the sheet says so.
    const unsigned = vi.fn().mockResolvedValue(ok(response('awaiting_second')));
    const other = await openSheet(unsigned, false, { tournamentId: 'trn_1', liveKeyIds: ['someone-else'] });
    expect((await within(other).findByTestId('signing-note')).getAttribute('data-signer')).toBe('not_checked_in');
    enterSweep(other);
    await interact(() => fireEvent.click(within(other).getByRole('button', { name: 'Submit scoreline' })));
    await waitFor(() => expect(unsigned).toHaveBeenCalled());
    expect(unsigned.mock.calls[0]?.[2]).toBeNull();
  });

  it('a queued scoreline carries its signature', async () => {
    const pair = await generateAttestationKeyPair();
    const publicKey = await exportPublicJwk(pair.publicKey);
    const keyId = await jwkThumbprint(publicKey);
    const keys = new MemoryKeyStore();
    await keys.write({ id: 'current', keyId, publicKey, privateKey: pair.privateKey });
    useDeviceKeyStoreForTests(keys);
    const store = new MemoryOutbox();
    useOutboxStoreForTests(store);
    const noAnswer: ApiResult<SubmitResponse> = { ok: false, error: { type: 'internal_error', code: 'unavailable', message: 'Could not reach Sideout.' }, status: 0, retryAfterMs: null };
    const sheet = await openSheet(vi.fn().mockResolvedValue(noAnswer), false, { tournamentId: 'trn_1', liveKeyIds: [keyId] });
    enterSweep(sheet);
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Submit scoreline' })));
    expect(await within(sheet).findByRole('heading', { name: 'Saved on this phone' })).toBeTruthy();
    await waitFor(async () => expect(await store.list()).toHaveLength(1));
    const [item] = await store.list();
    expect(item?.body.attestation).toMatchObject({ keyId, algorithm: 'ES256' });
  });

  it('a definitive refusal stays in the editor with the message, and closing refreshes the page', async () => {
    const refused: ApiResult<SubmitResponse> = { ok: false, error: { type: 'invalid_state', code: 'already_decided', message: 'Both teams have already confirmed this result; it is final.' }, status: 409, retryAfterMs: null };
    const sheet = await openSheet(vi.fn().mockResolvedValue(refused));
    enterSweep(sheet);
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Submit scoreline' })));
    expect((await within(sheet).findByRole('alert')).textContent).toContain('Close this sheet to see where the match stands.');
    await interact(() => fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' })));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
