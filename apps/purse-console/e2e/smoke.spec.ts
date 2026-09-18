import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { CREDENTIALS_FILE } from './global-setup';

/**
 * The console smoke (the brief's e2e): sign in as the seeded admin, open the ledger
 * explorer for the seeded settled contest, drill into its settlement entry and see the
 * lines balance, and run the invariant panel to green.
 */
const credentials = (): { email: string; password: string } => JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as { email: string; password: string };

test('an operator signs in, follows a settled contest into its settlement entry, and sees the invariants hold', async ({ page }) => {
  const { email, password } = credentials();

  // A page behind the frame sends a stranger to sign in, and back afterwards.
  await page.goto('/invariants');
  await expect(page).toHaveURL(/\/login\?next=%2Finvariants/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/invariants$/);
  await expect(page.getByRole('heading', { name: 'Invariants' })).toBeVisible();

  // The contest browser, filtered to settled, lists the seed's settled doubles.
  await page.goto('/contests?state=settled');
  const settled = page.getByRole('link', { name: /opening weekend doubles \(settled\)/ });
  await expect(settled).toBeVisible();
  await settled.click();
  await expect(page.getByRole('heading', { name: /opening weekend doubles/ })).toBeVisible();
  await expect(page.getByText('Settled', { exact: true }).first()).toBeVisible();

  // The results table links every payout to the one settlement entry; follow it into the ledger.
  const results = page.getByRole('table', { name: 'Results' });
  await expect(results).toBeVisible();
  const settlementLink = results.getByRole('link', { name: /^[0-9a-f]{8}$/ }).first();
  await settlementLink.click();
  await expect(page).toHaveURL(/\/entries\/je_/);
  await expect(page.getByRole('heading', { name: 'Settle entry' })).toBeVisible();
  await expect(page.getByTestId('entry-balanced')).toHaveText(/^Balanced: \d+ lines net to zero\.$/);
  // 500 escrowed into the settlement: 250 + 125 + 125 paid out, escrow debited 500.
  const totals = page.getByRole('table', { name: 'Per-asset totals' });
  await expect(totals.getByRole('cell', { name: '500' })).toHaveCount(2);
  await expect(totals.getByText('Ok')).toBeVisible();
  const lines = page.getByRole('table', { name: 'Journal lines' });
  await expect(lines.getByRole('row')).toHaveCount(5);
  await expect(lines.getByText('Contest escrow')).toBeVisible();

  // The escrow account reads zero now and, as of before anything posted, zero too.
  await lines.getByRole('link', { name: /^acct_/ }).first().click();
  await expect(page).toHaveURL(/\/accounts\/acct_/);
  await expect(page.getByTestId('balance-now')).toContainText('0');
  await page.goto(`${page.url()}?asOf=2000-01-01T00:00:00.000Z`);
  await expect(page.getByTestId('balance-as-of')).toContainText('0');

  // The invariant panel runs reconcile and reports green.
  await page.goto('/invariants');
  const panel = page.getByTestId('invariant-panel');
  await expect(panel).toHaveAttribute('data-status', 'ok');
  await expect(panel.getByText('All invariants hold')).toBeVisible();
  await expect(panel.locator('[data-invariant]')).toHaveCount(7);
  await expect(panel.locator('[data-status="failed"]')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Run now' }).click();
  await expect(panel).toHaveAttribute('data-status', 'ok');
  await expect(panel.getByText(/Last run \d{4}-\d{2}-\d{2}/)).toBeVisible();

  // Sign out ends the session: the frame refuses the next page.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/tenants');
  await expect(page).toHaveURL(/\/login\?next=%2Ftenants/);
});
