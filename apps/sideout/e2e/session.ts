import type { BrowserContext } from '@playwright/test';

import { BASE_URL, SESSION_SECRET } from '../playwright.config';
import { issueSession, SESSION_COOKIE } from '../src/server/auth/session';

/**
 * Sign the browser in as a seeded user. The production build has no dev login, so the
 * spec does what the server would: it mints a session with the app's own `issueSession`
 * under the secret the server runs with (`playwright.config.ts` hands the local server
 * one; a deployed run is given the deployment's), and sets it as the cookie on the
 * origin under test. `null` signs out.
 */
export async function signInAs(context: BrowserContext, userId: string | null): Promise<void> {
  await context.clearCookies();
  if (userId === null) return;
  const { token } = issueSession(userId, SESSION_SECRET, new Date());
  const origin = new URL(BASE_URL);
  await context.addCookies([{ name: SESSION_COOKIE, value: token, domain: origin.hostname, path: '/', httpOnly: true, sameSite: 'Lax', secure: origin.protocol === 'https:' }]);
}
