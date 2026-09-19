import { expect, test } from '@playwright/test';

import { captainOf, matchDetail, screens, settled, teamOf } from './helpers';
import { signInAs } from './session';

/**
 * Live scoring over Server-Sent Events (spec section 12, item 3; docs/live.md): two pages
 * on the seeded live event's match that is awaiting its second reading. One, signed in as
 * a member of the team that already submitted, watches the match; the other, the same
 * team's captain, replaces the scoreline through the score sheet. The watching page shows
 * the new reading within a few seconds without a reload, over the stream (the transport
 * attribute says so), and the standings tab of a third page re-renders on the same event.
 * Submitting for the team that already has a reading keeps the seed's state (one reading,
 * `awaiting_second`) for the other specs and for a rerun.
 */
test.describe('live updates', () => {
  test('a score submitted on one page reaches another without a reload', async ({ browser, request }) => {
    test.skip(test.info().project.name !== 'desktop', 'one transport check is enough; the flow is the same at every width');
    test.setTimeout(120_000);
    const { live } = await screens(request);
    const match = live.bracket?.matches.find((m) => m.status === 'awaiting_scores' && m.teamAId !== null && m.teamBId !== null);
    if (match === undefined) throw new Error('the live seed has no bracket match awaiting its second reading');
    const before = await matchDetail(request, match.id);
    const submittedTeamId = before.consensus?.live[0]?.teamId ?? null;
    if (submittedTeamId === null) throw new Error('the awaiting match has no first reading');
    const us = teamOf(live, submittedTeamId);
    const them = teamOf(live, submittedTeamId === match.teamAId ? match.teamBId : match.teamAId);
    const captain = captainOf(us);
    // A scoreline the seed (and a previous run) did not leave: the loser's points in set 1 alternate between 14 and 15.
    const current = (before.consensus?.live[0] as { sets?: Array<{ setNumber: number; teamAPoints: number; teamBPoints: number }> } | undefined)?.sets ?? [];
    const first = current.find((s) => s.setNumber === 1);
    const loserPoints = submittedTeamId === match.teamAId ? first?.teamBPoints : first?.teamAPoints;
    const themPoints = loserPoints === 14 ? 15 : 14;

    const watcherContext = await browser.newContext();
    const submitterContext = await browser.newContext();
    try {
      // The watcher: signed in as the captain too (the same team sees its own submitted reading), on the match page.
      await signInAs(watcherContext, captain.userId);
      const watcher = await watcherContext.newPage();
      await watcher.goto(`/m/${match.id}`);
      await settled(watcher);
      await expect(watcher.getByTestId('submit-panel')).toContainText(`waiting on ${them.name}`);
      await expect(watcher.locator('html')).toHaveAttribute('data-live', 'stream', { timeout: 15_000 });
      await watcher.evaluate(() => {
        (window as unknown as { __liveMarker: number }).__liveMarker = 1;
      });

      // A third page on the standings tab, a spectator, also on the stream.
      const standings = await watcherContext.newPage();
      await standings.goto(`/t/${live.slug}/standings`);
      await settled(standings);
      await expect(standings.locator('html')).toHaveAttribute('data-live', 'stream', { timeout: 15_000 });
      await standings.evaluate(() => {
        (window as unknown as { __liveMarker: number }).__liveMarker = 1;
      });
      const standingsRenders = await standings.evaluate(() => performance.getEntriesByType('resource').length);

      // The submitter replaces the team's reading through the sheet.
      await signInAs(submitterContext, captain.userId);
      const submitter = await submitterContext.newPage();
      await submitter.goto(`/m/${match.id}`);
      await settled(submitter);
      await submitter.getByRole('button', { name: 'Change your scoreline' }).click();
      const sheet = submitter.getByTestId('score-sheet');
      await expect(sheet).toBeVisible();
      const points = async (label: string, set: number, value: string) => {
        const box = sheet.getByRole('textbox', { name: `${label}, set ${set} points` });
        await box.fill(value);
        await expect(box).toHaveValue(value);
      };
      await points('Your team', 1, '21');
      await points(them.name, 1, String(themPoints));
      await points('Your team', 2, '21');
      await points(them.name, 2, '18');
      await sheet.getByRole('button', { name: 'Replace scoreline' }).click();
      await expect(sheet.getByRole('heading', { name: `Waiting on ${them.name}` })).toBeVisible({ timeout: 15_000 });
      await sheet.getByRole('button', { name: 'Done' }).click();
      await expect(sheet).toBeHidden();

      // The watcher shows the replaced reading within a few seconds, on the same document.
      const submitted = watcher.getByTestId('submit-panel').locator('table tbody tr').filter({ hasText: them.name });
      await expect(submitted).toContainText(String(themPoints), { timeout: 5_000 });
      expect(await watcher.evaluate(() => (window as unknown as { __liveMarker?: number }).__liveMarker)).toBe(1);
      await expect(watcher.locator('html')).toHaveAttribute('data-live', 'stream');

      // The standings page re-rendered from the server on the event, without navigating.
      await expect
        .poll(() => standings.evaluate(() => performance.getEntriesByType('resource').length), { timeout: 5_000 })
        .toBeGreaterThan(standingsRenders);
      expect(await standings.evaluate(() => (window as unknown as { __liveMarker?: number }).__liveMarker)).toBe(1);

      // Still one team's reading only (a seed rerun can leave the seeded row standing beside it; the other team has none).
      const after = await matchDetail(request, match.id);
      expect(after.consensus?.state).toBe('awaiting_second');
      expect(after.consensus?.live.map((s) => s.teamId).every((id) => id === us.id)).toBe(true);
    } finally {
      await watcherContext.close();
      await submitterContext.close();
    }
  });
});
