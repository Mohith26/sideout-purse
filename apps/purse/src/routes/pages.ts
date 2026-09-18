import { Hono, type Context } from 'hono';

import type { RequestScope } from '../http/request-id';

/**
 * Two pages Purse publishes on its own origin for every tenant's players (spec 4.8's
 * responsible-play links; docs/decisions.md, phase 8 "Where the responsible-play links
 * go"): the responsible-play policy, with the limits and self-exclusion section a wallet
 * links to as `#limits`, and the support path a restricted player is sent to. Plain,
 * server-rendered HTML on the design tokens' values, no script, cacheable for an hour;
 * Sideout links here (`server/pages.ts`, `purseLinks`) rather than keeping a second copy.
 */
const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #08090B; color: #F2F4F7; font: 16px/1.55 "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 0.5rem; }
  h2 { font-size: 1.125rem; line-height: 1.3; margin: 2rem 0 0.5rem; }
  p, li { color: #C6CBD4; }
  a { color: #D6FF3B; }
  .kicker { color: #7D8591; font-size: 0.8125rem; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 1rem; }
  .card { border: 1px solid #23262D; border-radius: 12px; padding: 1rem 1.25rem; margin: 1rem 0; background: #0F1115; }
  footer { margin-top: 3rem; color: #7D8591; font-size: 0.875rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Purse</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="kicker">Purse</p>
${body}
<footer><p>Purse is the competition platform behind this product. Its contest currencies, POINTS and CREDIT, are closed-loop: they cannot be bought, cashed out or transferred, and no real money is wagered. Charitable donations are handled by the product you play in, never by Purse.</p></footer>
</main>
</body>
</html>`;
}

const RESPONSIBLE_PLAY = page(
  'Responsible play',
  `<h1>Responsible play</h1>
<p>Contests on Purse are played for POINTS and CREDIT. POINTS are issued free and CREDIT is funded by sponsors and redeemable for goods; neither is legal tender, neither can be cashed out, and nothing you stake is money. Even so, competing for a prize can take more of your time and attention than you meant to give it. These are the controls, and they are yours to use.</p>
<h2 id="limits">Limits and self-exclusion</h2>
<div class="card">
<p><strong>Stake limits</strong> apply to every player: a maximum per contest, per day and per week, set by the active ruleset and enforced when you enter. An entry over a limit is refused with the reason, never silently trimmed.</p>
<p><strong>Cool-off</strong> pauses your account for a period you choose. <strong>Self-exclusion</strong> closes it to new entries for a month or longer. Both are placed from the wallet panel in the product you play in, take effect at once, and cannot be lifted by you before they end: a restriction you placed is honoured even when you ask for it to be removed. Entries already held in escrow settle as normal.</p>
</div>
<h2>Age and identity</h2>
<p>Every contest requires a minimum age, higher in some regions. A verified identity is required before CREDIT can be staked; POINTS contests may be entered before verification. Verification is performed by an identity provider, and a rejected verification is final for the account.</p>
<h2>If it stops being fun</h2>
<p>Talk to someone. The National Council on Problem Gambling's helpline is free, confidential and open all day: <a href="https://www.ncpgambling.org/help-treatment/" rel="noreferrer noopener">1-800-GAMBLER</a>. If you want your account closed for good, use self-exclusion, then <a href="/support">contact support</a>.</p>`,
);

const SUPPORT = page(
  'Support',
  `<h1>Support</h1>
<p>Purse holds the wallet, the contests and the eligibility decisions behind the product you play in; the product's organizers run the events. Most questions have a fast answer in one of two places.</p>
<h2>About an event, a score or a donation</h2>
<p>Ask the organizer of the event, from the product you entered it in. Scores are agreed between teams and settled by the organizer; donations are taken by the product and never touch Purse.</p>
<h2>About your account on Purse</h2>
<div class="card">
<p><strong>A refused entry</strong> names its reason: under the minimum age, a region the contest is not permitted in, a verification not yet complete, a stake over your limit, or a restriction on the account. The reason tells you what, if anything, would change it.</p>
<p><strong>A restriction</strong> placed by you (cool-off, self-exclusion) ends when it ends and cannot be lifted early, by anyone. A restriction placed by the platform is reviewed by a Purse operator; the product's organizer can raise it with them on your behalf.</p>
<p><strong>A rejected verification</strong> is final for the account. The account keeps what it holds and can still see its history.</p>
</div>
<h2>Reaching a Purse operator</h2>
<p>Purse operators work from the operator console and are reached through the product's organizer, who can open a review on your account. This is a demonstration platform: there is no public support desk, and no one from Purse will ever contact you asking for a code, a card or a payment.</p>
<p>The <a href="/responsible-play">responsible play policy</a> explains limits and self-exclusion.</p>`,
);

export function pageRoutes() {
  const serve = (html: string) => (c: Context<RequestScope>) => {
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    return c.html(html);
  };
  return new Hono<RequestScope>().get('/responsible-play', serve(RESPONSIBLE_PLAY)).get('/support', serve(SUPPORT));
}
