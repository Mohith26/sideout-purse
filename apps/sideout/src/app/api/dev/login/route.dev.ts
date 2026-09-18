import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { users } from '../../../../db/schema';
import { phoneE164Schema } from '../../../../server/auth/phone';
import { issueSession, sessionCookieHeader } from '../../../../server/auth/session';
import { appContext } from '../../../../server/context';
import { failure } from '../../../../server/http/errors';
import { parseJsonBody } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';
import { toPublicProfile } from '../../../../server/public-shape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({ phone: phoneE164Schema });

/**
 * Sign in as a seeded user without a code. This file is named `route.dev.ts`: Next only
 * treats `route.<ext>` files as routes for the extensions in `pageExtensions`, and
 * `next.config.ts` lists `dev.ts` only when `NODE_ENV !== 'production'`, so a production
 * build contains no `/api/dev/login` at all (`test/auth/dev-login.test.ts` proves the
 * mechanism). The runtime check below is belt and braces.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    if (env.nodeEnv === 'production') throw failure.notFound('not_found', 'Not found.');
    const body = await parseJsonBody(request, bodySchema);
    const [user] = await db.select().from(users).where(eq(users.phoneE164, body.phone)).limit(1);
    if (user === undefined) throw failure.notFound('user_not_found', 'No user has that phone number; run pnpm db:seed.');
    const now = new Date();
    const session = issueSession(user.id, env.sessionSecret, now);
    return ok(
      { user: toPublicProfile(user), sessionExpiresAt: session.expiresAt.toISOString() },
      { headers: { 'set-cookie': sessionCookieHeader(session.token, { secure: false }) } },
    );
  });
}
