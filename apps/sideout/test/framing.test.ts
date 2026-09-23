import { describe, expect, it } from 'vitest';

import { navItemsFor } from '../src/components/shell/nav';
import { CORRESPONDENCES, lucraFraming } from '../src/server/framing';

/**
 * The partner framing is a switch, and the point of the switch is that nothing else moves
 * with it. These tests hold both halves of that: the copy appears and disappears, and the
 * navigation is otherwise identical either way.
 */
describe('partner framing', () => {
  it('is on unless it is switched off', () => {
    expect(lucraFraming({}).enabled).toBe(true);
    expect(lucraFraming({ LUCRA_FRAMING: 'on' }).enabled).toBe(true);
    for (const off of ['off', 'OFF', 'false', '0', 'no', ' off ']) {
      expect(lucraFraming({ LUCRA_FRAMING: off }).enabled, `${off} turns it off`).toBe(false);
    }
  });

  it('takes the public variable when the server one is unset, so a static build can read it', () => {
    expect(lucraFraming({ NEXT_PUBLIC_LUCRA_FRAMING: 'off' }).enabled).toBe(false);
    // The server variable wins when both are set.
    expect(lucraFraming({ LUCRA_FRAMING: 'on', NEXT_PUBLIC_LUCRA_FRAMING: 'off' }).enabled).toBe(true);
  });

  it('adds exactly one navigation item, and removes it again', () => {
    const off = navItemsFor('player', 0, false);
    const on = navItemsFor('player', 0, true);
    expect(on).toHaveLength(off.length + 1);
    expect(on.filter((item) => item.href === '/lucra')).toHaveLength(1);
    expect(off.some((item) => item.href === '/lucra')).toBe(false);
    // Everything else is untouched, including the money page, which is not part of the framing.
    expect(off.map((item) => item.href)).toEqual(['/', '/events', '/money', '/impact', '/me']);
  });

  it('keeps the console link last for an organizer, framing or not', () => {
    for (const framing of [false, true]) {
      const items = navItemsFor('organizer', 3, framing);
      expect(items.at(-1)).toMatchObject({ href: '/organizer', badge: 3 });
    }
  });

  it('every correspondence names a real module path and says something specific', () => {
    expect(CORRESPONDENCES.length).toBeGreaterThanOrEqual(8);
    for (const row of CORRESPONDENCES) {
      expect(row.where, `${row.their} names a path`).toMatch(/^(apps|packages)\//);
      expect(row.detail.length, `${row.their} is explained`).toBeGreaterThan(80);
      expect(row.their.length).toBeGreaterThan(0);
      expect(row.ours.length).toBeGreaterThan(0);
    }
    // No duplicate claims.
    expect(new Set(CORRESPONDENCES.map((row) => row.their)).size).toBe(CORRESPONDENCES.length);
  });
});
