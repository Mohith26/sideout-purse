import { expect, test } from '@playwright/test';

import { captainOf, matchDetail, ORGANIZER_ID, screens, settled, teamOf } from './helpers';
import { signInAs } from './session';

/**
 * Signed score attestation (spec section 12, item 1; docs/attestation.md): a player checks
 * this phone in for their team from the register screen (the key pair is made in the
 * browser), the match page says the phone is checked in, a scoreline submitted from it is
 * signed on the phone and shown as signed once the server verified it, the other team's
 * unchecked phone submits unsigned, and the organizer sees which reading was signed in
 * the dispute queue and the phone on the event page. The match is the seeded live event's
 * last scheduled bracket match with both teams known (the offline spec takes the first);
 * on a reused database it may already be decided, in which case the flow is skipped.
 */
test.describe('signed score attestation', () => {
  test('check in, sign, the badge, the queue', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'mobile', 'the check-in flow is the phone flow');
    test.setTimeout(150_000);
    const { live } = await screens(request);
    const candidates = (live.bracket?.matches ?? []).filter((m) => m.status === 'scheduled' && m.teamAId !== null && m.teamBId !== null);
    const match = candidates.at(-1);
    if (match === undefined) throw new Error('the live seed has no scheduled bracket match with both teams');
    const fresh = await matchDetail(request, match.id);
    test.skip(fresh.consensus !== null && fresh.consensus.state !== 'awaiting_first', 'the match already has readings from an earlier run');
    const us = teamOf(live, match.teamAId);
    const them = teamOf(live, match.teamBId);
    const ourCaptain = captainOf(us);
    const theirCaptain = captainOf(them);

    // Check in: the register screen's third step generates the key on this phone and registers its public half.
    await signInAs(context, ourCaptain.userId);
    await page.goto(`/t/${live.slug}/register`);
    await settled(page);
    const checkIn = page.getByTestId('device-check-in');
    await expect(checkIn).toBeVisible();
    await expect(checkIn).toHaveAttribute('data-status', /^(not_checked_in|checked_in)$/);
    if ((await checkIn.getAttribute('data-status')) === 'not_checked_in') {
      await checkIn.getByRole('button', { name: 'Check in this phone' }).click();
    }
    await expect(checkIn).toHaveAttribute('data-status', 'checked_in', { timeout: 20_000 });
    await expect(checkIn.getByTestId('device-list').locator('li[data-revoked="false"]').filter({ hasText: 'this phone' })).toHaveCount(1);
    const devices = await request.get(`/api/teams/${us.id}/devices`);
    expect(devices.ok()).toBe(true);
    const registered = ((await devices.json()) as { data: { devices: Array<{ keyId: string; revokedAt: string | null; mirrored: boolean }> } }).data.devices.filter((d) => d.revokedAt === null);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.some((d) => d.mirrored)).toBe(true);

    // The match page knows this phone is checked in, and the sheet signs the scoreline before it is sent.
    await page.goto(`/m/${match.id}`);
    await settled(page);
    await expect(page.getByTestId('phone-status')).toHaveAttribute('data-status', 'checked_in');
    await page.getByRole('button', { name: /^(Submit score|Change your scoreline)$/ }).click();
    const sheet = page.getByTestId('score-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('signing-note')).toHaveAttribute('data-signer', 'checked_in');
    const points = async (label: string, set: number, value: string) => {
      const box = sheet.getByRole('textbox', { name: `${label}, set ${set} points` });
      await box.fill(value);
      await expect(box).toHaveValue(value);
    };
    await points('Your team', 1, '21');
    await points(them.name, 1, '16');
    await points('Your team', 2, '21');
    await points(them.name, 2, '19');
    await sheet.getByRole('button', { name: /^(Submit|Replace) scoreline$/ }).click();
    await expect(sheet.getByRole('heading', { name: `Waiting on ${them.name}` })).toBeVisible({ timeout: 20_000 });
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('readings').locator(`li[data-team="${us.id}"] [data-testid="attestation-badge"]`)).toHaveAttribute('data-attested', 'true', { timeout: 20_000 });
    const after = await matchDetail(request, match.id);
    expect(after.consensus?.state).toBe('awaiting_second');

    // The other team, from a phone that is not checked in for it: an unsigned, different reading, and a dispute.
    await signInAs(context, theirCaptain.userId);
    await page.goto(`/m/${match.id}`);
    await settled(page);
    await expect(page.getByTestId('phone-status')).toHaveAttribute('data-status', 'not_checked_in');
    await page.getByRole('button', { name: 'Confirm the result' }).click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('signing-note')).toHaveAttribute('data-signer', 'not_checked_in');
    // A different reading of set 1 (17, not 16): legal, and not what the other team sent.
    await points('Your team', 1, '17');
    await points(us.name, 1, '21');
    await points('Your team', 2, '19');
    await points(us.name, 2, '21');
    await sheet.getByRole('button', { name: 'Submit scoreline' }).click();
    await expect(sheet.getByRole('heading', { name: 'Scorelines differ' })).toBeVisible({ timeout: 20_000 });
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('readings').locator(`li[data-team="${them.id}"] [data-testid="attestation-badge"]`)).toHaveAttribute('data-attested', 'false', { timeout: 20_000 });

    // The organizer: the dispute queue names which side signed, and the event page lists the phone.
    await signInAs(context, ORGANIZER_ID);
    await page.goto('/organizer/disputes');
    await settled(page);
    const card = page.getByTestId('dispute-card').filter({ hasText: `${us.name} vs ${them.name}` });
    await expect(card).toBeVisible();
    const signatures = card.getByTestId('dispute-signatures');
    await expect(signatures.locator(`li[data-team="${us.id}"] [data-testid="attestation-badge"]`)).toHaveAttribute('data-attested', 'true');
    await expect(signatures.locator(`li[data-team="${them.id}"] [data-testid="attestation-badge"]`)).toHaveAttribute('data-attested', 'false');
    await page.goto(`/organizer/events/${live.id}`);
    await settled(page);
    const panel = page.getByTestId('device-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('tr[data-revoked="false"]').filter({ hasText: us.name })).toHaveCount(registered.length);
  });
});
