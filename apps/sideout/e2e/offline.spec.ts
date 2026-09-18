import { expect, test } from '@playwright/test';

import { captainOf, matchDetail, screens, settled, teamOf } from './helpers';
import { signInAs } from './session';

/**
 * Offline (spec 5.3 and the phase 8 brief): the production build registers the service
 * worker, a match page opened online is kept for reading without signal, a scoreline
 * submitted with no connection is queued on the phone, the queue survives a reload served
 * from the worker's cache, and it syncs through the same route (same validation, same
 * consensus path) once the connection returns. The match is the seeded live event's next
 * bracket match with both teams known and no result; the spec submits as one team only, so
 * the seed's state is a waiting first reading afterwards and a rerun supersedes it.
 */
test.describe('offline score submission', () => {
  test('queued offline, survives reload, syncs on reconnect', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'mobile', 'the offline flow is the phone flow');
    test.setTimeout(150_000);
    const { live } = await screens(request);
    const match = live.bracket?.matches.find((m) => m.status === 'scheduled' && m.teamAId !== null && m.teamBId !== null);
    if (match === undefined) throw new Error('the live seed has no scheduled bracket match with both teams');
    const us = teamOf(live, match.teamAId);
    const them = teamOf(live, match.teamBId);
    await signInAs(context, captainOf(us).userId);

    // Online first: the worker installs on the first visit and controls the page from the next one, which it caches.
    await page.goto(`/m/${match.id}`);
    await settled(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await settled(page);
    const trigger = page.getByRole('button', { name: /^(Submit score|Change your scoreline)$/ });
    await expect(trigger).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(async (path) => {
            for (const key of await caches.keys()) {
              if (!key.startsWith('sideout-pages-')) continue;
              const hit = await (await caches.open(key)).match(new URL(path, location.origin).toString(), { ignoreVary: true });
              if (hit) return true;
            }
            return false;
          }, `/m/${match.id}`),
        { message: 'the match page is cached for offline reading', timeout: 20_000 },
      )
      .toBe(true);

    // No signal: the sheet still opens and judges legality on the phone; submitting saves the scoreline instead of losing it.
    await context.setOffline(true);
    await expect(page.getByTestId('offline-status')).toHaveAttribute('data-offline', 'true');
    await expect(page.getByTestId('offline-status')).toContainText('No connection.');
    await trigger.click();
    const sheet = page.getByTestId('score-sheet');
    await expect(sheet).toBeVisible();
    const points = async (label: string, set: number, value: string) => {
      const box = sheet.getByRole('textbox', { name: `${label}, set ${set} points` });
      await box.fill(value);
      await expect(box).toHaveValue(value);
    };
    await points('Your team', 1, '21');
    await points(them.name, 1, '14');
    await points('Your team', 2, '21');
    await points(them.name, 2, '18');
    await expect(page.getByTestId('match-verdict')).toContainText(/Your team win 2–0/);
    await sheet.getByRole('button', { name: /^(Submit|Replace) scoreline$/ }).click();
    await expect(sheet.getByRole('heading', { name: 'Saved on this phone' })).toBeVisible();
    await expect(sheet.getByTestId('queued-notice')).toContainText('will be sent, with the same checks, as soon as you are back online');
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('offline-status')).toContainText('One scoreline is saved on this phone');
    const before = await matchDetail(request, match.id);
    expect(before.consensus?.live.some((s) => s.teamId === us.id && before.consensus?.state === 'agreed') ?? false).toBe(false);

    // Reload with no connection: the worker serves the page and the queue is still there, in match orientation.
    await page.reload();
    await expect(page.getByTestId('offline-status')).toHaveAttribute('data-offline', 'true');
    const queued = page.getByTestId('queued-score');
    await expect(queued).toBeVisible();
    await expect(queued).toHaveAttribute('data-status', 'queued');
    await expect(queued).toContainText('Queued on this phone');
    await expect(queued.locator('tbody tr').filter({ hasText: us.name })).toContainText('21');
    await expect(queued.locator('tbody tr').filter({ hasText: them.name })).toContainText('14');

    // Back online: the outbox replays through POST /api/matches/:id/scores, the phone says so, and the page shows the reading it produced.
    await context.setOffline(false);
    await expect(page.getByRole('status').filter({ hasText: 'Queued scoreline sent' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('queued-score')).toHaveCount(0);
    await expect(page.getByTestId('submit-panel')).toContainText(`waiting on ${them.name}`, { timeout: 30_000 });
    const after = await matchDetail(request, match.id);
    expect(after.consensus?.state).toBe('awaiting_second');
    expect(after.consensus?.live.map((s) => s.teamId)).toEqual([us.id]);
    expect(after.match.status).toBe('awaiting_scores');
  });

  test('a page never opened is answered by the offline page, not a browser error', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'mobile', 'the offline flow is the phone flow');
    const { live } = await screens(request);
    await signInAs(context, null);
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await context.setOffline(true);
    await page.goto(`/t/${live.slug}/impact?fresh=${Date.now()}`);
    await expect(page.getByRole('heading', { level: 1, name: /No connection/ })).toBeVisible();
    await context.setOffline(false);
  });
});
