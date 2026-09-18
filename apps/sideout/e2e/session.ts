import type { BrowserContext } from '@playwright/test';

import { E2E_SESSION_SECRET } from '../playwright.config';
import { issueSession, SESSION_COOKIE } from '../src/server/auth/session';

/**
 * Sign the browser in as a seeded user. The production build has no dev login, so the
 * spec does what the server would: it mints a session with the app's own `issueSession`
 * under the secret `playwright.config.ts` handed the server, and sets it as the cookie.
 * `null` signs out.
 */
export async function signInAs(context: BrowserContext, userId: string | null): Promise<void> {
  await context.clearCookies();
  if (userId === null) return;
  const { token } = issueSession(userId, E2E_SESSION_SECRET, new Date());
  await context.addCookies([{ name: SESSION_COOKIE, value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}
