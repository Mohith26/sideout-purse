import path from 'node:path';

import { expect, test } from '@playwright/test';

import { SCREENSHOT_DIR } from '../playwright.config';
import { screens, settled, userFor } from './helpers';
import { signInAs } from './session';

/**
 * The smoke: every screen of spec 5.3 renders on the seeded data at this project's width
 * with the content the seed puts there, and a screenshot of each (the page from the top, capped
 * in height) lands in docs/screenshots/<screen>-<width>.png. Anonymous, player and organizer screens sign in
 * as the seeded identities `helpers.ts` names; a role-gated screen sends a stranger away.
 */
/** A capture is the page from the top down to here; the live board at 390 runs to nine thousand pixels. */
const MAX_CAPTURE_HEIGHT = 3200;

test.describe('every screen', () => {
  test('renders and is captured', async ({ page, context, request }) => {
    test.setTimeout(300_000);
    const width = page.viewportSize()?.width ?? 0;
    const { list, live } = await screens(request);
    for (const screen of list) {
      await signInAs(context, userFor(screen));
      const response = await page.goto(screen.path);
      // A page under a loading boundary streams, so the missing event answers 200 with the not-found screen in the stream.
      expect(response?.status(), `${screen.name} status`).toBeLessThan(500);
      await settled(page);
      await expect(page.locator('main h1').first(), `${screen.name} has a heading`).toBeVisible();
      // No horizontal page scroll at any width: what is wider than the screen scrolls inside its own container.
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
      expect(overflow.page, `${screen.name} scrolls sideways: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.viewport);
      expect(overflow.body, `${screen.name} scrolls sideways: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.viewport);
      if (screen.name === 'not-found') await expect(page.getByRole('heading', { level: 1, name: 'No page here' })).toBeVisible();
      // The tab bar is fixed to the viewport; for a full-page capture it sits at the foot of the page instead of mid-way down.
      const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), MAX_CAPTURE_HEIGHT);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${screen.name}-${width}.png`), fullPage: true, clip: { x: 0, y: 0, width, height }, animations: 'disabled', style: '.so-tabbar { position: absolute; }' });
    }

    // The live event is on the home strip; the console is a 404 to anyone but an organizer, and a player screen sends a stranger to sign in.
    await signInAs(context, null);
    await page.goto('/');
    await expect(page.getByTestId('live-strip')).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(live.name) }).first()).toBeVisible();
    await page.goto('/organizer/events');
    await expect(page.getByRole('heading', { level: 1, name: 'No page here' })).toBeVisible();
    await page.goto('/me');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fme$/);
  });

  test('the tournament tabs, the bracket and the standings carry what the seed drew', async ({ page, request }) => {
    const { live } = await screens(request);
    await page.goto(`/t/${live.slug}`);
    await settled(page);
    const tabs = page.getByRole('navigation', { name: `${live.name} sections` });
    for (const tab of ['Overview', 'Bracket', 'Standings', 'Impact']) await expect(tabs.getByRole('link', { name: tab })).toBeVisible();

    await tabs.getByRole('link', { name: 'Bracket' }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${live.slug}/bracket$`));
    const bracket = page.getByTestId('bracket');
    await expect(bracket).toBeVisible();
    const nodes = bracket.locator('[data-node-id]');
    await expect(nodes).toHaveCount(live.bracket?.matches.length ?? 0);
    await expect(bracket.locator('[data-node-id][data-status="bye"]').first()).toBeAttached();

    await tabs.getByRole('link', { name: 'Standings' }).click();
    await expect(page.getByTestId('standings-table')).toHaveCount(live.pools.length);
    await expect(page.locator('[data-flip-rows] [data-team-id]')).toHaveCount(live.teams.length);
    await expect(page.getByText(/point differential/i).first()).toBeVisible();

    await tabs.getByRole('link', { name: 'Impact' }).click();
    await expect(page.getByTestId('impact-meter')).toBeVisible();
    await expect(page.getByRole('progressbar')).toBeVisible();
  });
});
