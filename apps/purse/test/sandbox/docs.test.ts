import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerSeamTable } from '../../src/docs/providers';
import { documentedExamples, escapeHtml } from '../../src/routes/docs';
import { harness, type TestHarness } from '../helpers';

describe('public docs', () => {
  let h: TestHarness;
  beforeAll(() => { h = harness(); });
  afterAll(async () => { await h.close(); });

  it('documents every registered v1 endpoint using request and response contract fixtures', async () => {
    const response = await h.app.request('/docs');
    expect(response.status).toBe(200);
    const html = await response.text();
    const endpoints = h.app.routes.filter((r) => r.path.startsWith('/v1/') && !['ALL', 'OPTIONS'].includes(r.method));
    expect(endpoints.length).toBeGreaterThan(25);
    for (const route of endpoints) {
      const pattern = new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}/?$`);
      const fixture = documentedExamples.find((f) => f.request.method === route.method && pattern.test(f.request.path));
      expect(fixture, `Missing contract example: ${route.method} ${route.path}`).toBeDefined();
      if (fixture === undefined) continue;
      expect(html).toContain(escapeHtml(JSON.stringify(fixture.request, null, 2)));
      expect(html).toContain(escapeHtml(JSON.stringify(fixture.response.body, null, 2)));
    }
  });

  it('keeps the provider table verbatim and discloses sandbox limits and seams', async () => {
    const source = readFileSync(new URL('../../../../docs/providers.md', import.meta.url), 'utf8');
    expect(providerSeamTable).toBe(source.slice(source.indexOf('| Seam |'), source.indexOf('\n## Configuration')).trim());
    const response = await h.app.request('/docs');
    const html = await response.text();
    expect(html).toContain('architecture exercise, not a licensed operator');
    expect(html).toContain('Outbound webhooks are unavailable');
    expect(html).toContain('24 hours');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await h.app.request('/docs/client.js')).status).toBe(200);
    expect((await h.app.request('/docs/style.css')).status).toBe(200);
  });
});
