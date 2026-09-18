import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { captainOf, matchDetail, ORGANIZER_ID, screens, settled, teamOf, userFor } from './helpers';
import { signInAs } from './session';

/**
 * The accessibility pass (spec 6.5 and the phase 8 brief): axe over every screen at 390
 * and 1280 with nothing serious or critical; one h1 per screen and no skipped level; every
 * freestanding control at least 44×44 and the steppers 56; the focus ring the stylesheet
 * gives every focused control (2px volt at 2px offset); keyboard walks of the bracket, the
 * score sheet, a confirm dialog and the console navigation; and polite live regions where
 * scores and standings change.
 */
const MIN_TARGET = 44;
const STEPPER = 56;

test.describe('accessibility', () => {
  test('axe finds nothing serious or critical on any screen', async ({ page, context, request }) => {
    test.skip(test.info().project.name === 'tablet', 'the pass runs at 390 and 1280');
    test.setTimeout(300_000);
    const { list } = await screens(request);
    const findings: string[] = [];
    for (const screen of list) {
      await signInAs(context, userFor(screen));
      await page.goto(screen.path);
      await settled(page);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
      for (const violation of results.violations) {
        if (violation.impact !== 'serious' && violation.impact !== 'critical') continue;
        findings.push(`${screen.name}: ${violation.id} (${violation.impact}) — ${violation.help}: ${violation.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      }
    }
    expect(findings, findings.join('\n')).toEqual([]);
  });

  test('every screen has one h1 and skips no heading level', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'desktop', 'the outline is the same at every width');
    test.setTimeout(180_000);
    for (const screen of (await screens(request)).list) {
      await signInAs(context, userFor(screen));
      await page.goto(screen.path);
      await settled(page);
      const levels = await page.locator('main h1, main h2, main h3, main h4').evaluateAll((els) => els.map((el) => Number(el.tagName.slice(1))));
      expect(levels.filter((l) => l === 1), `${screen.name}: one h1`).toHaveLength(1);
      let previous = 0;
      for (const level of levels) {
        expect(level - previous, `${screen.name}: heading levels ${levels.join(',')}`).toBeLessThanOrEqual(1);
        previous = level;
      }
    }
  });

  test('every freestanding control is a 44px target and focus shows a 2px volt ring at 2px offset', async ({ page, context, request }) => {
    test.skip(test.info().project.name === 'tablet', 'the audit runs at 390 and 1280');
    test.setTimeout(240_000);
    const { list, live } = await screens(request);
    const small: string[] = [];
    for (const screen of list) {
      await signInAs(context, userFor(screen));
      await page.goto(screen.path);
      await settled(page);
      // Standalone controls: buttons, links and inputs outside running text (a link inside a sentence or a table cell is inline, WCAG 2.5.8's exception).
      const boxes = await page.locator('main button, main a[href], main input:not([type=hidden]), main select, main textarea, nav a[href], nav button').evaluateAll((els) =>
        els
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            return el.closest('p, td, th, dd, [data-inline-text]') === null || el.tagName === 'BUTTON' || el.tagName === 'INPUT';
          })
          .map((el) => {
            // A stretched link over a card is as large as the card.
            const box = (el.getAttribute('data-target') === 'card' ? (el.closest('article') ?? el) : el).getBoundingClientRect();
            return { label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40), tag: el.tagName, w: box.width, h: box.height };
          }),
      );
      for (const b of boxes) if (b.w < MIN_TARGET || b.h < MIN_TARGET) small.push(`${screen.name}: <${b.tag.toLowerCase()}> "${b.label}" ${Math.round(b.w)}×${Math.round(b.h)}`);
    }
    expect(small, small.join('\n')).toEqual([]);

    // Focus ring: tab to the first control on the live event and read the ring the stylesheet gives it.
    await signInAs(context, null);
    await page.goto(`/t/${live.slug}`);
    await settled(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return null;
      const s = getComputedStyle(el);
      return { tag: el.tagName, outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, outlineOffset: s.outlineOffset, outlineColor: s.outlineColor, focusVisible: el.matches(':focus-visible') };
    });
    expect(ring?.focusVisible, JSON.stringify(ring)).toBe(true);
    expect(ring).toMatchObject({ outlineWidth: '2px', outlineStyle: 'solid', outlineOffset: '2px' });
    // --volt (#d7ff3e) as the browser reports it.
    expect(ring?.outlineColor).toBe('rgb(215, 255, 62)');
  });

  test('the bracket is a keyboard-navigable canvas: arrows move between matches, Enter opens one, byes are announced', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'desktop', 'one width covers the keyboard walk');
    const { live } = await screens(request);
    await signInAs(context, null);
    await page.goto(`/t/${live.slug}/bracket`);
    await settled(page);
    const canvas = page.getByRole('group', { name: /canvas\. Use the arrow keys/ });
    await expect(canvas).toBeVisible();
    // One node is in the tab order (a roving tabindex); the rest are reachable with the arrows.
    await expect(canvas.locator('[data-node-id][tabindex="0"]')).toHaveCount(1);
    await canvas.locator('[data-node-id][tabindex="0"]').focus();
    const focused = () => page.evaluate(() => ({ id: document.activeElement?.getAttribute('data-node-id') ?? null, round: Number(document.activeElement?.getAttribute('data-round')) }));
    const first = await focused();
    expect(first.id).not.toBeNull();
    // Right moves a round forward, left a round back (to the nearest feeder, which need not be the one we left).
    await page.keyboard.press('ArrowRight');
    const next = await focused();
    expect(next.id).not.toBe(first.id);
    expect(next.round).toBe(first.round + 1);
    await page.keyboard.press('ArrowLeft');
    expect((await focused()).round).toBe(first.round);
    // Up and down walk the column; from an end of the column one of them stays put, the other moves.
    await page.keyboard.press('ArrowDown');
    const down = await focused();
    await page.keyboard.press('ArrowUp');
    const up = await focused();
    expect(down.id !== first.id || up.id !== first.id).toBe(true);
    expect(down.round).toBe(first.round);
    // A bye names itself as one.
    await expect(canvas.locator('[data-node-id][data-status="bye"]').first()).toHaveAttribute('aria-label', /bye/i);
    // Enter on a played match opens it.
    const played = canvas.locator('a[data-node-id][data-status="final"]').first();
    const playedId = await played.getAttribute('data-node-id');
    await played.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/m/${playedId ?? ''}$`));
  });

  test('the score sheet is a keyboard-operable modal: focus lands inside, Tab stays inside, Escape closes and returns focus', async ({ page, context, request }) => {
    test.skip(test.info().project.name === 'tablet', 'the walk runs on the phone and the desktop');
    const { live } = await screens(request);
    const awaiting = live.bracket?.matches.find((m) => m.status === 'awaiting_scores');
    if (awaiting === undefined) throw new Error('the live seed has no awaiting match');
    const view = await matchDetail(request, awaiting.id);
    const submitted = view.consensus?.live[0]?.teamId ?? null;
    const confirming = teamOf(live, awaiting.teamAId === submitted ? awaiting.teamBId : awaiting.teamAId);
    await signInAs(context, captainOf(confirming).userId);
    await page.goto(`/m/${awaiting.id}`);
    await settled(page);
    const trigger = page.getByRole('button', { name: 'Confirm the result' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByTestId('score-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toBeFocused();
    // Tab walks every control in the sheet and never leaves it (the page behind a modal dialog is inert).
    const tabbable = await sheet.evaluate((root) => root.querySelectorAll("button:not([disabled]), input:not([disabled]), a[href], [tabindex='0']").length);
    expect(tabbable).toBeGreaterThan(6);
    for (let i = 0; i < tabbable; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => document.activeElement?.closest("[data-testid='score-sheet']") !== null);
      expect(inside, `tab ${i + 1} stays inside the sheet`).toBe(true);
    }
    // The steppers are 56px and operable by keyboard.
    const plus = sheet.getByRole('button', { name: 'Increase Your team, set 1' });
    await plus.focus();
    await page.keyboard.press('Enter');
    await expect(sheet.getByRole('textbox', { name: 'Your team, set 1 points' })).toHaveValue('1');
    const box = await plus.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(STEPPER);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(STEPPER);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the console navigation and a confirm dialog are keyboard-operable', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'desktop', 'one width covers the keyboard walk');
    const { live } = await screens(request);
    await signInAs(context, ORGANIZER_ID);
    await page.goto('/organizer/events');
    await settled(page);
    const nav = page.getByRole('navigation', { name: 'Console' });
    await nav.getByRole('link', { name: 'Events' }).focus();
    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: /^Disputes/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/organizer\/disputes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Disputes' })).toBeVisible();
    await expect(page.getByTestId('dispute-badge')).toBeVisible();

    // The forfeit control on the live board opens a confirm dialog: Escape cancels it and focus returns.
    await page.goto(`/organizer/events/${live.id}/board`);
    await settled(page);
    const forfeit = page.getByRole('button', { name: /forfeits$/ }).first();
    await forfeit.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('scores and standings sit in polite live regions', async ({ page, context, request }) => {
    test.skip(test.info().project.name !== 'mobile', 'markup is the same at every width');
    const { live } = await screens(request);
    await signInAs(context, null);
    await page.goto('/');
    await expect(page.getByTestId('live-strip').locator("[aria-live='polite']").first()).toBeAttached();
    await page.goto(`/t/${live.slug}/standings`);
    await expect(page.locator("[aria-live='polite'][data-flip-rows]").first()).toBeAttached();
    const played = live.bracket?.matches.find((m) => m.status === 'final');
    await page.goto(`/m/${played?.id ?? ''}`);
    await expect(page.getByTestId('result-line')).toHaveAttribute('aria-live', 'polite');
    // The breathing dot marks live play only: the event's header carries it while the event is live.
    await page.goto(`/t/${live.slug}`);
    await expect(page.locator('[data-live-dot]').first()).toBeVisible();
  });
});
