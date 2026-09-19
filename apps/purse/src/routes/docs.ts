import { Hono } from 'hono';

import { docsClient } from '../docs/client';
import fixtures from '../docs/contract-fixtures.json';
import { providerSeamTable } from '../docs/providers';
import type { RateLimitConfig } from '../http/rate-limit';
import type { RequestScope } from '../http/request-id';

/**
 * The request and response examples the public page renders are the API contract
 * fixtures themselves (`src/docs/contract-fixtures.json`), so the page cannot drift from
 * the API: `test/contract/contract.test.ts` records them from live requests and fails when
 * the file differs, and `UPDATE_CONTRACT_FIXTURES=1 pnpm --filter @purse/api test
 * test/contract` rewrites it after a deliberate contract change. It lives under `src/`
 * because it ships: shipped source never imports from `test/`, which `.dockerignore`
 * drops from every image's build context (docs/decisions.md).
 */
export const documentedExamples = fixtures;
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
const json = (value: unknown): string => escapeHtml(JSON.stringify(value, null, 2));

function providerTable(): string {
  const rows = providerSeamTable.split('\n').filter((_, i) => i !== 1);
  return `<div class="scroll"><table>${rows.map((row, i) => `<tr>${row.slice(1, -1).split(/(?<!\\)\|/).map((cell) => `<${i === 0 ? 'th' : 'td'}>${escapeHtml(cell.trim().replaceAll('\\|', '|'))}</${i === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</table></div>`;
}

const css = `
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#08090b;color:#f4f5f7;font-size:15px;line-height:1.55}
*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:32px 16px 64px}h1{font-size:clamp(2.5rem,6vw,4rem);line-height:1.1}h2{font-size:1.5rem;margin-top:48px}h3{font-size:1.125rem}a{color:#d7ff3e}p{max-width:80ch}small,.muted{color:#9ba3af}nav{display:flex;gap:24px;flex-wrap:wrap}section,details{border:1px solid #323843;border-radius:10px;padding:24px;margin:16px 0;background:#101216}section h2{margin-top:0}summary{cursor:pointer;min-height:44px;overflow-wrap:anywhere}pre,code,textarea{font-family:ui-monospace,monospace}pre{background:#050607;border:1px solid #22262d;border-radius:6px;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:16px 0 8px}input,textarea,select,button{font:inherit;min-height:44px;border:1px solid #323843;border-radius:6px;padding:10px;background:#171a1f;color:#f4f5f7}input,textarea,select{width:100%}textarea{min-height:180px}button{cursor:pointer}button.primary{background:#d7ff3e;color:#08090b;font-weight:600}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:2px solid #d7ff3e;outline-offset:2px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;min-width:850px}td,th{text-align:left;vertical-align:top;padding:16px;border:1px solid #323843}th{color:#d7ff3e}.pair{display:grid;gap:16px}@media(min-width:768px){.pair{grid-template-columns:1fr 1fr}}.pair>*{min-width:0}
`;

export function renderDocs(enabled: boolean, rateLimit: RateLimitConfig): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Purse API — docs and sandbox</title><link rel="stylesheet" href="/docs/style.css"><script src="/docs/client.js" defer></script></head><body><main>
<nav aria-label="Docs"><a href="#sandbox">Try it</a><a href="#api">API reference</a><a href="#seams">Provider seams</a><a href="#embed">Embed and SDK</a></nav>
<h1>Purse API</h1><p>Purse provides contests, eligibility, an append-only double-entry ledger and deterministic settlement for competition products. Sideout is the charity beach volleyball product built on it.</p>
<p>Licensing and real KYC are deliberately out of scope; this is an architecture exercise, not a licensed operator. Assets are closed-loop POINTS and CREDIT, never real money. Donations are separate from Purse.</p>
<section id="sandbox"><h2>Try it in your own sandbox</h2><p>A sandbox is a fresh tenant isolated from the seeded demo and every other tenant. Its keys expire in 24 hours. Verification, geolocation and risk use the dev provider seams described below; do not enter real personal information.</p>
<p>Three sandboxes per address per 24 hours. Minting permits a burst of three per address, refilling one per hour, and ten per API process, refilling one per minute. Limits also apply to retries. Outbound webhooks are unavailable on self-serve sandboxes: webhook mutations return a permission error. Your secret key has operator scope only inside your tenant, so you can issue test credits and close your contests.</p>
<p>Expired tenants are retired and their keys revoked by <code>db:purge</code>. Journal, audit and tenant data are retained to preserve append-only history. Authentication refuses expired keys immediately, even before purge runs. Hosts running the nightly demo reset clear sandbox users, contests and ledger data too; keys and minting quotas survive the reset.</p>
<p>${enabled ? 'Self-serve minting is enabled on this host.' : 'Self-serve minting is disabled on this host.'} Keys are returned once and held only in this page’s memory. Reloading clears them. Copy them now if you need them again.</p>
<button class="primary" id="mint" ${enabled ? '' : 'disabled'}>Mint sandbox keys</button><pre id="keys" aria-label="Sandbox keys">No keys minted.</pre>
<label for="example">Request example</label><select id="example">${fixtures.map((f, i) => `<option value="${i}">${escapeHtml(f.request.method + ' ' + f.request.path + ' — ' + f.name)}</option>`).join('')}</select>
<p>Edit placeholder ids and fields as needed. Successful responses fill the most recent user, contest and token into newly selected examples. Start with creating a user and a contest. Embed requests use the publishable key and may require a session. The internal endpoints require a host token and cannot be called with a sandbox key.</p>
<label for="path"><span id="method">POST</span> path</label><input id="path" spellcheck="false"><label for="body">JSON request body</label><textarea id="body" spellcheck="false"></textarea><button id="run" disabled>Run request</button><p id="message" role="status" aria-live="polite"></p>
<div class="pair"><div><h3>Raw request</h3><pre id="request">No request yet.</pre></div><div><h3>Raw response</h3><pre id="response">No response yet.</pre></div></div><details><summary>Contract response example</summary><pre id="expected"></pre></details></section>
<h2>Authentication, idempotency and limits</h2><p>Use <code>Authorization: Bearer sk_sandbox_…</code> on the v1 API. Managed integrations keep secret keys on their server; this page deliberately uses a throwaway sandbox key. Publishable keys (<code>pk_sandbox_…</code>) authenticate the embed browser routes. <code>POST /v1/sandbox/keys</code> and <code>GET /v1/health</code> and <code>GET /v1/status</code> are public.</p>
<p>Every secret-key v1 mutation requires an <code>Idempotency-Key</code>. Reuse it to retry the same action; changing a request under the same key returns a conflict. Normal responses are remembered for at least 30 days. Minting retries are scoped to the address and return the same tenant with null keys; secrets are never stored for replay. This panel generates a new UUID per attempt.</p>
<p>Authenticated requests have a per-key burst of ${rateLimit.burst}, refilling ${rateLimit.perSecond} per second. Responses use <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and, on refusal, <code>Retry-After</code>. Failed authentication and embed requests have address limits. In-memory limits are per process; the three-sandbox bound persists across restarts and replicas. Responses are <code>{ data }</code> or <code>{ error: { type, code, message, detail? } }</code>. Money amounts are decimal strings in minor units.</p>
<h2 id="api">API reference</h2><p>These request and response examples come directly from the API contract fixtures. Angle-bracket values are placeholders. Error examples are included. Coverage is checked against the registered v1 routes.</p>
${fixtures.map((f) => `<details><summary><code>${escapeHtml(f.request.method + ' ' + f.request.path)}</code> — ${escapeHtml(f.name)}</summary><h3>Request</h3><pre>${json(f.request)}</pre><h3>Response · ${f.response.status}</h3><pre>${json(f.response.body)}</pre></details>`).join('')}
<h2 id="seams">Provider seams</h2>${providerTable()}
<h2 id="embed">Embed protocol and SDK</h2><p>Use <a href="https://github.com/Mohith26/sideout-purse/tree/main/packages/purse-sdk">@purse/sdk</a> to initialize with a publishable key and tenant id, mount a flow with a server-issued embed token, read user state and subscribe to flow completion or errors. Headless mode supports reads. The shared protocol is in <a href="https://github.com/Mohith26/sideout-purse/blob/main/packages/purse-types/src/protocol.ts">@purse/types</a>, version 1.</p>
<p>The iframe lives on the Purse origin. Every message targets an exact origin, validates its origin against the tenant allowlist and its shape with Zod. A handshake establishes a nonce required on later messages. Embed tokens are single-use, user-and-flow scoped, and expire in five minutes. Identity cookies are Secure, HttpOnly, SameSite=None and Partitioned. The SDK passes theme variables and negotiates resize without internal scrollbars.</p>
<script type="application/json" id="examples">${JSON.stringify(fixtures).replaceAll('<', '\\u003c')}</script></main></body></html>`;
}

export function docsRoutes(deps: { enabled: boolean; rateLimit: RateLimitConfig }) {
  const routes = new Hono<RequestScope>();
  routes.get('/docs', (c) => {
    c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(renderDocs(deps.enabled, deps.rateLimit));
  });
  routes.get('/docs/client.js', (c) => { c.header('Content-Type', 'text/javascript; charset=utf-8'); return c.body(docsClient); });
  routes.get('/docs/style.css', (c) => { c.header('Content-Type', 'text/css; charset=utf-8'); return c.body(css); });
  return routes;
}
