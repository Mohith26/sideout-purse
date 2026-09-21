import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import manifest, { MANIFEST_BACKGROUND, MANIFEST_THEME } from '../../src/app/manifest';

/**
 * The installable PWA (spec 5.3): a manifest whose colours are the base background token,
 * the icons it names present, and a service worker that precaches the offline page,
 * caches only what a signed-in player may read offline, and never touches a write.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const tokens = readFileSync(path.resolve(ROOT, '../../packages/ui/src/styles/beach.css'), 'utf8');
const sw = readFileSync(path.resolve(ROOT, 'public/sw.js'), 'utf8');

describe('manifest', () => {
  it('is installable: standalone display, a start url, icons of both purposes, and colours pinned to the tokens', () => {
    const m = manifest();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.icons?.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(m.icons?.some((i) => i.purpose === 'any')).toBe(true);
    const base = /--bg-base:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1]?.toLowerCase();
    expect(MANIFEST_THEME).toBe(base);
    expect(MANIFEST_BACKGROUND).toBe(base);
    // `/icon.svg` is the app router's icon file; the PNGs are static files under public/.
    for (const icon of m.icons ?? []) {
      const file = icon.src === '/icon.svg' ? path.resolve(ROOT, 'src/app/icon.svg') : path.resolve(ROOT, 'public', icon.src.replace(/^\//, ''));
      expect(() => readFileSync(file), icon.src).not.toThrow();
    }
  });
});

describe('service worker', () => {
  it('reads its version from the registration query and precaches the offline page', () => {
    expect(sw).toMatch(/searchParams\.get\('v'\)/);
    expect(sw).toMatch(/PRECACHE = \[OFFLINE_URL, '\/manifest\.webmanifest'/);
  });

  it('handles only GET, only this origin, never Next RSC fetches, and only the readable API routes', () => {
    expect(sw).toMatch(/if \(request\.method !== 'GET'\) return;/);
    expect(sw).toMatch(/if \(url\.origin !== self\.location\.origin\) return;/);
    expect(sw).toMatch(/request\.headers\.get\('RSC'\) === '1'/);
    expect(sw).toMatch(/API_ALLOWLIST = \[\/\^\\\/api\\\/tournaments\(\\\/\|\$\)\/, \/\^\\\/api\\\/matches\\\/\/, \/\^\\\/api\\\/me\$\/\]/);
    expect(sw).toMatch(/PAGE_DENYLIST = \[[^\]]*\/\^\\\/organizer\/[^\]]*\]/);
  });

  it('drops the pages it cached when asked (sign-out on a shared phone) and old versions on activation', () => {
    expect(sw).toMatch(/type === 'clear-pages'/);
    expect(sw).toMatch(/caches\.delete\(PAGES_CACHE\), caches\.delete\(API_CACHE\)/);
    expect(sw).toMatch(/key\.startsWith\('sideout-'\) && !OWN_CACHES\.has\(key\)/);
  });
});
