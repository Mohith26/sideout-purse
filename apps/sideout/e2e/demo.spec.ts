import { expect, test, type Page } from '@playwright/test';

import { settled } from './helpers';

/**
 * The public demo's account picker (`DEMO_ACCOUNTS`, `docs/demo-accounts.md`): a visitor
 * signs in as a curated seeded user from `/sign-in`, lands where that account's story
 * starts, and every screen carries the "Demo" pill until sign-out. Read-only against the
 * seeded events (no scoreline is submitted here; the flows spec does that on events of
 * its own), so it runs before the flows in every screen project. Skips itself when the
 * build under test was made without the switch (`playwright.config.ts`).
 */
const SIGN_IN_AS = /^Sign in as /;

async function pick(page: Page, key: string): Promise<void> {
  await page.goto('/sign-in');
  await settled(page);
  await page.getByTestId('demo-accounts').getByTestId(`demo-account-${key}`).getByRole('button', { name: SIGN_IN_AS }).click();
}

test.describe('demo accounts', () => {
  test.beforeEach(async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { data: { demoAccounts: boolean } };
    test.skip(!body.data.demoAccounts, 'the build under test was made without DEMO_ACCOUNTS; `DEMO_ACCOUNTS=true pnpm build` first');
  });

  test('the picker lists six seeded roles above the untouched phone form, and Captain A lands on the match awaiting the other side', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/sign-in');
    await settled(page);
    const picker = page.getByTestId('demo-accounts');
    await expect(picker.getByRole('heading', { name: 'Demo accounts' })).toBeVisible();
    await expect(picker.getByRole('button', { name: SIGN_IN_AS })).toHaveCount(6);
    // The phone form is still there, exactly as it is, below the picker.
    await expect(page.getByLabel('Phone number')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Text me a code' })).toBeVisible();
    await expect(page.getByTestId('demo-pill')).toHaveCount(0);

    const captainA = picker.getByTestId('demo-account-captain_a');
    await expect(captainA).toContainText('Captain A');
    await expect(captainA).toContainText('Awaiting scores');
    await expect(captainA).toContainText('scoreline is in');
    await captainA.getByRole('button', { name: SIGN_IN_AS }).click();

    await expect(page).toHaveURL(/\/m\/mch_[0-9a-f-]{36}$/);
    await settled(page);
    await expect(page.getByTestId('demo-pill')).toContainText('Demo');
    // Team A's scoreline is in: the panel says who we wait on, the sheet is offered to revise it.
    await expect(page.getByTestId('submit-panel')).toContainText('waiting on');
    await expect(page.getByRole('button', { name: 'Change your scoreline' })).toBeVisible();
    // A demo session is a normal session: the profile answers.
    const me = await page.request.get('/api/me');
    expect(me.ok()).toBe(true);
  });

  test('the organizer lands in the console, Captain B is offered the answering sheet', async ({ page, context, browser }) => {
    await context.clearCookies();
    await pick(page, 'organizer');
    await expect(page).toHaveURL(/\/organizer\/events$/);
    await settled(page);
    await expect(page.getByTestId('demo-pill')).toBeVisible();

    const other = await (await browser.newContext()).newPage();
    await pick(other, 'captain_b');
    await expect(other).toHaveURL(/\/m\/mch_[0-9a-f-]{36}$/);
    await settled(other);
    await expect(other.getByTestId('demo-pill')).toBeVisible();
    await expect(other.getByTestId('submit-panel')).toContainText('has submitted a result');
    await expect(other.getByRole('button', { name: 'Confirm the result' })).toBeVisible();
    await other.context().close();
  });

  test('the two Purse-state players land on their profile in the state their card promised', async ({ page, context }) => {
    await context.clearCookies();
    await pick(page, 'refused');
    await expect(page).toHaveURL(/\/me$/);
    await settled(page);
    const refused = page.getByTestId('verification-row');
    await expect(refused).toHaveAttribute('data-state', 'rejected', { timeout: 30_000 });
    await expect(refused).toContainText('Purse could not verify this account');

    await context.clearCookies();
    await pick(page, 'verifying');
    await expect(page).toHaveURL(/\/me$/);
    await settled(page);
    const verifying = page.getByTestId('verification-row');
    await expect(verifying).toHaveAttribute('data-state', 'unstarted', { timeout: 30_000 });
    await expect(verifying.getByRole('button', { name: 'Verify with Purse' })).toBeVisible();
  });

  test('a deep link is honoured after a demo sign-in, and sign-out drops the pill', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/sign-in?next=%2Fevents');
    await settled(page);
    await page.getByTestId('demo-accounts').getByTestId('demo-account-registrant').getByRole('button', { name: SIGN_IN_AS }).click();
    await expect(page).toHaveURL(/\/events$/);
    await settled(page);
    await expect(page.getByTestId('demo-pill')).toBeVisible();
    await page.request.post('/api/auth/logout', { data: {} });
    await page.goto('/events');
    await settled(page);
    await expect(page.getByTestId('demo-pill')).toHaveCount(0);
  });
});
