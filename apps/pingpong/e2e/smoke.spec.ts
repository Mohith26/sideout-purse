import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { OFFICE_CODE, PURSE_URL, SCREENSHOT_DIR } from '../playwright.config';

/**
 * The second tenant, end to end (docs/second-tenant.md): two players sign in with the
 * office code, link Purse, enter the season in Purse's own frame, the commissioner starts
 * play, the lower player challenges and wins, both confirm, the ladder reorders, the
 * result is pushed to Purse, and the commissioner closes the season through the frozen
 * preview: the payouts land in the players' Purse wallets and Purse's ledger reconciles.
 */
const STAMP = Date.now().toString(36).slice(-5);
const ADA = `Ada ${STAMP}`;
const GRACE = `Grace ${STAMP}`;

/** The ladder screen, hydrated: the client component has taken over the server-rendered forms. */
async function ready(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="ladder-screen"][data-hydrated="true"]')).toBeVisible({ timeout: 30_000 });
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await ready(page);
}

async function signIn(page: Page, name: string): Promise<void> {
  await page.goto('/');
  const form = page.getByTestId('sign-in-form');
  await expect(form.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  await form.getByLabel('Your name').fill(name);
  await form.getByLabel('Office code').fill(OFFICE_CODE);
  // The sign-in form is a client component too; submit through its handler, not the browser's.
  await form.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/ladder', { timeout: 30_000 });
  await ready(page);
  await expect(page.getByTestId('signed-in-as')).toHaveText(name);
}

async function linkPurse(page: Page): Promise<void> {
  await page.getByTestId('link-purse').click();
  await expect(page.getByText('Linked')).toBeVisible({ timeout: 30_000 });
}

async function enterSeason(page: Page): Promise<void> {
  await page.getByTestId('enter-season').click();
  const frame = page.frameLocator('[data-testid="purse-slot"] iframe');
  await expect(frame.getByRole('button', { name: 'Confirm entry' })).toBeEnabled({ timeout: 30_000 });
  await frame.getByRole('button', { name: 'Confirm entry' }).click();
  // The frame reports the entry; the page reads the entrants back from Purse and seats the player.
  await expect(page.getByRole('status').filter({ hasText: /on the ladder|already held/ })).toBeVisible({ timeout: 30_000 });
}

function ladderNames(page: Page): Promise<string[]> {
  return page.getByTestId('ladder').locator('tbody tr').evaluateAll((rows) => rows.map((row) => (row.querySelector('td:nth-child(2)')?.textContent ?? '').replace(' (you)', '').trim()));
}

async function pointsOf(page: Page): Promise<string> {
  await reload(page);
  const stat = page.locator('.so-stat').filter({ hasText: 'POINTS balance' });
  return (await stat.locator('.so-stat__value').first().textContent())?.replace(/[^0-9]/g, '') ?? '';
}

test('two players, one confirmed result, the ladder reorders, the season closes and the payouts land', async ({ browser, request }) => {
  const contextA: BrowserContext = await browser.newContext();
  const contextB: BrowserContext = await browser.newContext();
  const ada = await contextA.newPage();
  const grace = await contextB.newPage();

  // ---- Ada opens the season and is its commissioner.
  await signIn(ada, ADA);
  const openForm = ada.getByTestId('open-season-form');
  if (await openForm.isVisible()) {
    await openForm.getByLabel('Season title').fill(`Season ${STAMP}`);
    await openForm.getByRole('button', { name: 'Open season' }).click();
  }
  await expect(ada.getByTestId('season-title')).toBeVisible();
  await expect(ada.getByText('Commissioner you')).toBeVisible();

  // ---- Both link Purse and enter the season in Purse's frame.
  await linkPurse(ada);
  await enterSeason(ada);
  expect(await ladderNames(ada)).toEqual([ADA]);

  await signIn(grace, GRACE);
  await linkPurse(grace);
  await enterSeason(grace);
  expect(await ladderNames(grace)).toEqual([ADA, GRACE]);

  // ---- Ada starts play: the contest locks and starts on Purse.
  await reload(ada);
  await ada.getByTestId('start-season').click();
  await expect(ada.getByText('Playing', { exact: true })).toBeVisible({ timeout: 30_000 });

  // ---- Grace, second, challenges Ada, first, and reports 11–7.
  await reload(grace);
  const adaRow = grace.getByTestId('ladder').locator('tbody tr').filter({ hasText: ADA });
  await adaRow.getByRole('button', { name: 'Challenge' }).click();
  const report = grace.getByTestId('report-form');
  await expect(report).toBeVisible();
  await report.getByLabel(GRACE).fill('11');
  await report.getByLabel(ADA).fill('7');
  await report.getByRole('button', { name: 'Report result' }).click();
  await expect(grace.getByText('Waiting for the other side to confirm.')).toBeVisible();

  // ---- Ada confirms: the ladder reorders and the running scores go to Purse.
  await reload(ada);
  await ada.getByTestId('confirm-result').click();
  await expect(ada.getByTestId('match-history')).toContainText('moved up', { timeout: 30_000 });
  await expect(ada.getByTestId('match-history')).toContainText('pushed to Purse');
  expect(await ladderNames(ada)).toEqual([GRACE, ADA]);

  // ---- The two-step close: the frozen preview, then the exact hash.
  await ada.getByTestId('preview-close').click();
  const preview = ada.getByTestId('frozen-preview');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByTestId('payout-row')).toHaveCount(2);
  await expect(preview.getByTestId('payout-row').first()).toContainText(GRACE);
  await expect(preview.getByTestId('payout-row').first()).toContainText('125');
  await ada.getByTestId('confirm-close').click();
  const settlement = ada.getByTestId('settlement');
  await expect(settlement).toBeVisible({ timeout: 30_000 });
  await expect(settlement.getByTestId('result-row')).toHaveCount(2);
  await expect(settlement.getByTestId('result-row').first()).toContainText('125');
  await expect(settlement.getByTestId('result-row').last()).toContainText('75');
  await ada.evaluate(() => window.scrollTo(0, 0));
  await ada.screenshot({ path: path.join(SCREENSHOT_DIR, 'pingpong-settled.png'), fullPage: true });

  // ---- The payouts landed: 1000 welcome, 100 staked, 125 back to the winner, 75 to the loser.
  expect(await pointsOf(grace)).toBe('1025');
  expect(await pointsOf(ada)).toBe('975');

  // ---- The audit holds the calls, and Purse's ledger still reconciles.
  await ada.goto('/audit');
  await expect(ada.getByTestId('purse-calls')).toContainText('/v1/contests/');
  await expect(ada.getByTestId('purse-calls')).toContainText('/close');
  const purseHealth = (await (await request.get(`${PURSE_URL}/health`)).json()) as { data: { status: string; reconcile: { ok: boolean } | null } };
  expect(purseHealth.data.status).toBe('ok');
  const health = (await (await request.get('/health')).json()) as { data: { purse: { reachable: boolean; status?: string } } };
  expect(health.data.purse).toMatchObject({ reachable: true, status: 'ok' });

  await contextA.close();
  await contextB.close();
});
