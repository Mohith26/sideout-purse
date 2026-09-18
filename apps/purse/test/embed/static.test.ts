import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../../src/db/client';
import { addOrigin } from '../../src/embed/origins';
import { connectMigrator, harness, type TestHarness } from '../helpers';
import { bootstrapTenant } from '../http/client';
import { wipeLedger } from '../ledger/fixtures';

/**
 * The embed app is served by the API under `/embed` (spec 4.8 rule 1: the frame is on the
 * Purse origin). A build's files are served with `frame-ancestors` naming every tenant's
 * origins, immutable caching for hashed assets and none for the page; a checkout without
 * a build answers 404 with a hint; nothing outside the export directory is reachable.
 */
describe('embed static serving', () => {
  let migrator: Database;
  let dir: string;
  let served: TestHarness;
  let unbuilt: TestHarness;
  beforeAll(async () => {
    migrator = connectMigrator();
    await wipeLedger(migrator);
    dir = await mkdtemp(path.join(tmpdir(), 'purse-embed-'));
    await mkdir(path.join(dir, '_next', 'static', 'chunks'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><body>embed</body></html>');
    await writeFile(path.join(dir, '_next', 'static', 'chunks', 'main-abc123.js'), 'console.log("embed")');
    await writeFile(path.join(tmpdir(), 'purse-embed-outside.txt'), 'not for serving');
    served = harness({ embedDir: dir });
    unbuilt = harness();
    const boot = await bootstrapTenant(served.database.db);
    await addOrigin(served.database.db, { tenantId: boot.tenantId, origin: 'https://sideout.example' });
    await addOrigin(served.database.db, { tenantId: boot.tenantId, origin: 'http://localhost:3000' });
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await served.close();
    await unbuilt.close();
  });

  it('serves the page and its assets with the security and caching headers', async () => {
    const page = await served.app.request('/embed/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('embed');
    expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'self' http://localhost:3000 https://sideout.example");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    const asset = await served.app.request('/embed/_next/static/chunks/main-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const redirect = await served.app.request('/embed');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/embed/');
    const missing = await served.app.request('/embed/nope.js');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('never serves a path outside the export', async () => {
    for (const attempt of ['/embed/../purse-embed-outside.txt', '/embed/%2e%2e/purse-embed-outside.txt', '/embed/..%2fpurse-embed-outside.txt']) {
      const response = await served.app.request(attempt);
      expect(response.status, attempt).toBe(404);
    }
  });

  it('answers 404 with a hint when no build exists', async () => {
    const page = await unbuilt.app.request('/embed/');
    expect(page.status).toBe(404);
    expect(((await page.json()) as { error: { code: string } }).error.code).toBe('embed_not_built');
  });
});
