import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { BASE_URL, INTERNAL_TOKEN, PURSE_URL, SESSION_SECRET } from '../playwright.config';
import { buildSeed, defaultSeedAnchor } from '../src/db/seed';
import { issueSession, SESSION_COOKIE } from '../src/server/auth/session';
import { captainOf, detail, getJson, matchDetail, ORGANIZER_ID, settled, SLUGS, teamOf, type Team, type TournamentDetail } from './helpers';
import { signInAs } from './session';

/**
 * The two end-to-end flows of spec section 8, on the seed and against whatever `BASE_URL`
 * names (a local production build by default, the deployed environment for acceptance
 * criterion 30):
 *
 *   Player     register → view pool → submit score → opponent agrees → final → standings update
 *   Organizer  resolve dispute → close through frozen preview → payouts land in wallets → invariants clean
 *
 * The seed provides the material (`src/db/seed/build.ts`, phase 9): the free-entry
 * Community Cup with one complete pair still to register, the Boardwalk Invitational with
 * pool matches still to play, and the Dune Cup, complete but for a disputed final. Both
 * flows consume it, so a rerun needs the demo reset first (`e2e/global-setup.ts` runs it
 * locally; docs/deploy.md says how for the deployment). Every subject is read from the
 * public API rather than hard-coded, so the specs name whatever the seed drew.
 */
type Standing = { teamId: string; rank: number; wins: number; losses: number };
type StandingsView = { pools: Array<{ poolId: string; label: string; standings: Standing[] }> };

const standings = (request: APIRequestContext, slug: string): Promise<StandingsView> => getJson<StandingsView>(request, `/api/tournaments/${slug}/standings`);

/** Fill one side of a set in the score sheet and check the value took. */
async function points(page: Page, label: string, set: number, value: string): Promise<void> {
  const box = page.getByTestId('score-sheet').getByRole('textbox', { name: `${label}, set ${set} points` });
  await box.fill(value);
  await expect(box).toHaveValue(value);
}

/** Submit `sets` (our points first) from the open match page as the signed-in captain. */
async function submitScoreline(page: Page, them: Team, sets: ReadonlyArray<readonly [number, number]>): Promise<void> {
  const trigger = page.getByRole('button', { name: /^(Submit score|Confirm the result)$/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByTestId('score-sheet')).toBeVisible();
  for (const [index, [ours, theirs]] of sets.entries()) {
    await points(page, 'Your team', index + 1, String(ours));
    await points(page, them.name, index + 1, String(theirs));
  }
  await page.getByTestId('score-sheet').getByRole('button', { name: /^(Submit|Replace) scoreline$/ }).click();
}

test.describe('Player flow', () => {
  test.use({ isMobile: true, hasTouch: true });

  test('register → view pool → submit score → opponent agrees → final → standings update', async ({ page, context, browser, request }) => {
    test.setTimeout(240_000);

    // ---- Register: the Community Cup is free to enter, and one complete pair has not registered yet.
    const cup = await detail(request, SLUGS.communityCup);
    expect(cup.status).toBe('registration_open');
    const candidate = findRegisteringCaptain(cup);
    await signInAs(context, candidate.captainId);
    await page.goto(`/t/${SLUGS.communityCup}/register`);
    await settled(page);
    const stepOne = page.getByTestId('register-step-1');
    await expect(stepOne).toContainText('No entry fee');
    await stepOne.getByRole('button', { name: /^Register / }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Your place is reserved' })).toBeVisible();
    await expect(page.getByTestId('register-step-2')).toBeVisible();
    await settled(page);
    const afterRegister = await detail(request, SLUGS.communityCup);
    expect(afterRegister.teams.map((t) => t.id)).toContain(candidate.teamId);

    // The Purse contest entry, in Purse's own frame on Purse's origin, then read back by the server.
    const entryStep = page.getByTestId('purse-entry-step');
    await expect(entryStep).toBeVisible();
    const alreadyIn = await entryStep.getByTestId('entry-done').isVisible();
    if (!alreadyIn) {
      await entryStep.getByRole('button', { name: 'Enter the contest on Purse' }).click();
      const frame = page.frameLocator('[data-testid="entry-slot"] iframe');
      await expect(frame.getByRole('button', { name: 'Confirm entry' })).toBeEnabled({ timeout: 30_000 });
      await frame.getByRole('button', { name: 'Confirm entry' }).click();
      await expect(frame.getByText('You are in')).toBeVisible({ timeout: 30_000 });
      await expect(entryStep.getByTestId('entry-done')).toBeVisible({ timeout: 30_000 });
    }
    await expect(entryStep).toContainText('Entered');

    // ---- View pool: the Boardwalk Invitational is mid pool play; the captain of a team with a match still to play.
    const boardwalk = await detail(request, SLUGS.boardwalk);
    expect(boardwalk.status).toBe('live');
    const match = boardwalk.pools.flatMap((p) => p.matches).find((m) => m.status === 'scheduled' && m.teamAId !== null && m.teamBId !== null);
    if (match === undefined) throw new Error('the Boardwalk seed has no scheduled pool match left; run the demo reset before this flow');
    const pool = boardwalk.pools.find((p) => p.id === match.poolId);
    if (pool === undefined) throw new Error('scheduled match without a pool');
    const us = teamOf(boardwalk, match.teamAId);
    const them = teamOf(boardwalk, match.teamBId);
    const before = await standings(request, SLUGS.boardwalk);
    const ourRowBefore = before.pools.find((p) => p.poolId === pool.id)?.standings.find((s) => s.teamId === us.id);
    if (ourRowBefore === undefined) throw new Error('our team is not in its pool standings');

    await signInAs(context, captainOf(us).userId);
    await page.goto(`/t/${SLUGS.boardwalk}/standings`);
    await settled(page);
    const ourPool = page.getByRole('region', { name: `${pool.label} standings` });
    await expect(ourPool).toBeVisible();
    await expect(ourPool.locator(`[data-team-id="${us.id}"]`)).toContainText(`${ourRowBefore.wins}–${ourRowBefore.losses}`);

    // ---- Submit score: ours, in as many sets as the format takes (pool play is one set to 21).
    const ours: ReadonlyArray<readonly [number, number]> = match.bestOf === 1 ? [[21, 15]] : [[21, 15], [21, 17]];
    await page.goto(`/m/${match.id}`);
    await settled(page);
    await submitScoreline(page, them, ours);
    await expect(page.getByTestId('score-sheet').getByTestId('waiting-notice')).toBeVisible();
    await page.getByTestId('score-sheet').getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('submit-panel')).toContainText(new RegExp(`waiting on ${them.name}`, 'i'));
    expect((await matchDetail(request, match.id)).consensus?.state).toBe('awaiting_second');

    // ---- Opponent agrees, from their own phone: the same result, from the other side.
    const opponent = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await signInAs(opponent, captainOf(them).userId);
      const theirPage = await opponent.newPage();
      await theirPage.goto(`/m/${match.id}`);
      await settled(theirPage);
      await expect(theirPage.getByTestId('submit-panel')).toContainText(us.name);
      await submitScoreline(theirPage, us, ours.map(([a, b]) => [b, a] as const));
      await expect(theirPage.getByTestId('score-sheet').getByTestId('agreed-notice')).toContainText('Both teams agree. The match is final.');
      await theirPage.close();
    } finally {
      await opponent.close();
    }

    // ---- Final: the match is settled by consensus, and our phone learns it on its next refresh.
    const final = await matchDetail(request, match.id);
    expect(final.match.status).toBe('final');
    expect(final.consensus?.state === 'confirmed' || final.consensus?.state === 'agreed' || final.consensus?.state === 'pushed_to_purse').toBe(true);
    await page.reload();
    await settled(page);
    await expect(page.getByTestId('team-a')).toBeVisible();
    await expect(page.getByTestId('result-line')).toContainText('21');

    // ---- Standings update: one more win for us in the pool, on the page and in the API.
    const after = await standings(request, SLUGS.boardwalk);
    const ourRowAfter = after.pools.find((p) => p.poolId === pool.id)?.standings.find((s) => s.teamId === us.id);
    expect(ourRowAfter?.wins).toBe(ourRowBefore.wins + 1);
    await page.goto(`/t/${SLUGS.boardwalk}/standings`);
    await settled(page);
    await expect(page.getByRole('region', { name: `${pool.label} standings` }).locator(`[data-team-id="${us.id}"]`)).toContainText(`${ourRowBefore.wins + 1}–${ourRowBefore.losses}`);
  });
});

test.describe('Organizer flow', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('resolve dispute → close through frozen preview → payouts land in wallets → invariants clean', async ({ page, context, request }) => {
    test.setTimeout(240_000);
    const dune = await detail(request, SLUGS.duneCup);
    expect(dune.status).toBe('live');
    const finalMatch = (dune.bracket?.matches ?? []).find((m) => m.status === 'disputed');
    if (finalMatch === undefined) throw new Error('the Dune Cup seed has no disputed match; run the demo reset before this flow');
    const teamA = teamOf(dune, finalMatch.teamAId);
    const teamB = teamOf(dune, finalMatch.teamBId);

    // ---- Resolve the dispute from the queue, starting from team A's reading, attributed to the organizer.
    await signInAs(context, ORGANIZER_ID);
    await page.goto('/organizer/disputes');
    await settled(page);
    const card = page.getByTestId('dispute-card').filter({ hasText: dune.name });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: `Start from ${teamA.name}` }).click();
    await card.getByRole('button', { name: 'Resolve as organizer' }).click();
    await expect(card.getByTestId('dispute-settled')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('dispute-settled')).toContainText('Settled by');
    const resolved = await matchDetail(request, finalMatch.id);
    expect(resolved.match.status).toBe('final');
    const winner = resolved.match.winnerTeamId === teamA.id ? teamA : teamB;

    // ---- End play, then close through Purse's frozen preview.
    await page.goto(`/organizer/events/${dune.id}`);
    await settled(page);
    const actions = page.getByTestId('status-actions');
    await actions.getByRole('button', { name: 'End play' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'End play' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Now awaiting settlement/i })).toBeVisible({ timeout: 30_000 });
    // The page re-renders from the server after the move (`router.refresh()`); give the refresh its time.
    await expect(actions).toContainText('Play is over', { timeout: 20_000 });

    // What the winning captain's wallet holds before the close: the payout lands on top of it.
    const winningCaptain = captainOf(winner);
    const walletBefore = await purseWallet(request, winningCaptain.userId);

    await page.goto(`/organizer/events/${dune.id}/close`);
    await settled(page);
    await expect(page.getByTestId('no-blockers')).toContainText('Every match is final and confirmed with Purse');
    await page.getByRole('button', { name: 'Fetch the preview', exact: true }).click();
    const preview = page.getByTestId('frozen-preview');
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toContainText(winner.name);
    await page.getByRole('button', { name: /^Close with hash / }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close and settle' }).click();
    const closed = page.getByTestId('close-settled');
    await expect(closed).toBeVisible({ timeout: 60_000 });
    await expect(closed).toContainText(winner.name);
    const settledDetail = await detail(request, SLUGS.duneCup);
    expect(settledDetail.status).toBe('settled');

    // ---- Payouts land in wallets: the winning captain's profile shows the placement and the wallet Purse holds now.
    await signInAs(context, winningCaptain.userId);
    await page.goto('/me');
    await settled(page);
    const rewards = page.getByTestId('rewards-panel');
    await expect(rewards).toContainText(dune.name);
    const rewardRow = rewards.locator('tr').filter({ hasText: dune.name });
    await expect(rewardRow).toContainText('1st');
    const payoutText = (await rewardRow.locator('td').last().innerText()).trim();
    const payout = BigInt(payoutText.replace(/[^0-9]/g, ''));
    expect(payout).toBeGreaterThan(0n);
    const chip = page.getByTestId('wallet-chip');
    await expect(chip).toHaveAttribute('data-state', 'linked', { timeout: 30_000 });
    const balanceText = (await chip.getByTestId('wallet-balance').locator('span').filter({ hasText: 'POINTS' }).innerText()).replace(/[^0-9]/g, '');
    expect(BigInt(balanceText)).toBe(walletBefore + payout);
    expect(await purseWallet(request, winningCaptain.userId)).toBe(walletBefore + payout);

    // ---- Invariants clean: Purse's own reconcile, recorded, and reported on both /health endpoints.
    if (INTERNAL_TOKEN === undefined) throw new Error('the invariant check needs the Purse API’s INTERNAL_API_TOKEN (E2E_PURSE_INTERNAL_TOKEN for a deployed run)');
    const reconcile = await request.get(`${PURSE_URL}/internal/reconcile`, { headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` } });
    expect(reconcile.status(), await reconcile.text()).toBe(200);
    const report = (await reconcile.json()) as { data: { ok: boolean; invariants: Array<{ id: string; ok: boolean }> } };
    expect(report.data.ok).toBe(true);
    expect(report.data.invariants.filter((i) => !i.ok)).toEqual([]);
    const purseHealth = (await (await request.get(`${PURSE_URL}/health`)).json()) as { data: { status: string; reconcile: { ok: boolean } | null } };
    expect(purseHealth.data.status).toBe('ok');
    expect(purseHealth.data.reconcile?.ok).toBe(true);
    const sideoutHealth = (await (await request.get('/health')).json()) as { data: { purse: { reachable: boolean; reconcile?: { ok: boolean } | null } } };
    expect(sideoutHealth.data.purse).toMatchObject({ reachable: true, reconcile: { ok: true } });
  });
});

/**
 * The Community Cup pair to register: the seed's complete forming team (the public detail
 * lists only teams with a place, so the seed dataset, whose ids are stable, names it), as
 * long as it has not registered yet.
 */
function findRegisteringCaptain(cup: TournamentDetail): { captainId: string; teamId: string } {
  const dataset = buildSeed({ anchor: defaultSeedAnchor() });
  const tournament = dataset.tournaments.find((t) => t.slug === cup.slug);
  const teams = dataset.teams.filter((t) => t.tournamentId === tournament?.id && t.status === 'forming');
  for (const team of teams) {
    const members = dataset.teamMembers.filter((m) => m.teamId === team.id);
    const captain = members.find((m) => m.role === 'captain');
    if (members.length !== 2 || captain === undefined) continue;
    if (cup.teams.some((t) => t.id === team.id)) continue;
    return { captainId: captain.userId, teamId: team.id };
  }
  throw new Error('the Community Cup seed has no complete pair left to register; run the demo reset before this flow');
}

/** The POINTS balance Purse holds for a Sideout user right now, through Sideout's own profile read (a session is minted for the call). */
async function purseWallet(request: APIRequestContext, userId: string): Promise<bigint> {
  const { token } = issueSession(userId, SESSION_SECRET, new Date());
  const response = await request.get('/api/me/purse', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { data: { wallet: Array<{ asset: string; balance: string }> } };
  return BigInt(body.data.wallet.find((w) => w.asset === 'POINTS')?.balance ?? '0');
}
