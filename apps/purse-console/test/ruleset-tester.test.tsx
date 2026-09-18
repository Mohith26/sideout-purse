import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RulesetTestInput, RulesetTestResource } from '@purse/types';

import { RulesetTester } from '../src/components/RulesetTester';
import { click } from './mock-api';

/** The tester sends the sample as the evaluator's input with money as strings and shows the sealed decision. */
describe('RulesetTester', () => {
  it('submits the sample under the chosen version with money as decimal strings and renders a refusal with its reasons', async () => {
    const evaluate = vi.fn(async (input: RulesetTestInput): Promise<{ ok: true; data: RulesetTestResource }> => {
      await Promise.resolve();
      return {
        ok: true,
        data: {
          rulesetVersion: input.rulesetVersion ?? 'none',
          asOf: input.asOf ?? '',
          decision: { allowed: false, rulesetVersion: input.rulesetVersion ?? 'none', reasons: ['under_minimum_age', 'insufficient_balance'], requiredAction: 'add_funds' },
        },
      };
    });
    render(<RulesetTester versions={[{ version: '2026.09.1', active: true }, { version: '2026.10.1', active: false }]} evaluate={evaluate} />);
    fireEvent.change(screen.getByLabelText('Ruleset version'), { target: { value: '2026.10.1' } });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2012-05-05' } });
    fireEvent.change(screen.getByLabelText('Entry amount'), { target: { value: '12345' } });
    fireEvent.change(screen.getByLabelText('Wallet balance'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Contest asset'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('Restriction in force'), { target: { value: 'cool_off' } });
    await click(screen.getByRole('button', { name: 'What would this decide?' }));
    await waitFor(() => expect(screen.getByTestId('tester-decision')).toBeTruthy());
    expect(evaluate).toHaveBeenCalledTimes(1);
    const sent = evaluate.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      rulesetVersion: '2026.10.1',
      user: { dateOfBirth: '2012-05-05', verificationState: 'verified', region: 'US-TX', restrictions: [{ kind: 'cool_off', endsAt: null }] },
      contest: { asset: 'CREDIT', entryAmount: '12345', kind: 'tournament' },
      wallet: { balance: '10' },
      velocity: { enteredLast24h: '0', enteredLast7d: '0' },
    });
    expect(typeof sent?.contest.entryAmount).toBe('string');
    expect(screen.getByTestId('tester-decision').getAttribute('data-allowed')).toBe('false');
    expect(screen.getByText('Not eligible')).toBeTruthy();
    expect(screen.getByText('under minimum age')).toBeTruthy();
    expect(screen.getByText('add funds')).toBeTruthy();
  });

  it('shows an allowed decision and renders an API refusal', async () => {
    const evaluate = vi.fn(async (): Promise<{ ok: true; data: RulesetTestResource }> => {
      await Promise.resolve();
      return { ok: true, data: { rulesetVersion: '2026.09.1', asOf: 'now', decision: { allowed: true, rulesetVersion: '2026.09.1' } } };
    });
    render(<RulesetTester versions={[{ version: '2026.09.1', active: true }]} evaluate={evaluate} />);
    await click(screen.getByRole('button', { name: 'What would this decide?' }));
    await waitFor(() => expect(screen.getByTestId('tester-decision').getAttribute('data-allowed')).toBe('true'));
    expect(screen.getByText('Allowed')).toBeTruthy();

    const refusing = vi.fn(async (): Promise<{ ok: false; error: { type: 'invalid_request'; code: string; message: string } }> => {
      await Promise.resolve();
      return { ok: false, error: { type: 'invalid_request', code: 'ruleset_not_found', message: 'No ruleset version 2026.09.1' } };
    });
    render(<RulesetTester versions={[{ version: '2026.09.1', active: true }]} evaluate={refusing} />);
    await click(screen.getAllByRole('button', { name: 'What would this decide?' })[1]!);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('invalid_request/ruleset_not_found'));
  });

  it('refuses to submit a non-integer amount', () => {
    const evaluate = vi.fn();
    render(<RulesetTester versions={[{ version: '2026.09.1', active: true }]} evaluate={evaluate} />);
    fireEvent.change(screen.getByLabelText('Entry amount'), { target: { value: '1.5' } });
    const button = screen.getByRole('button', { name: 'What would this decide?' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Entry amount').getAttribute('aria-invalid')).toBe('true');
  });
});
