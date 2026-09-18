import { z } from 'zod';

import { clientAddress } from '../../../../server/auth/client-address';
import { phoneE164Schema } from '../../../../server/auth/phone';
import { issueSession, sessionCookieHeader } from '../../../../server/auth/session';
import { appContext } from '../../../../server/context';
import { parseJsonBody } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';
import { toPublicProfile } from '../../../../server/public-shape';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({
  phone: phoneE164Schema,
  /** The id `request-code` returned for the code being answered; guesses count against that code alone. */
  codeId: z.string().startsWith('otp_'),
  code: z.string().regex(/^\d{6}$/, 'six digits'),
  displayName: z.string().trim().min(2).max(60).optional(),
});

/** Finish phone sign-in: consume the code, create the account on first sign-in, set the session cookie. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { auth, env } = appContext();
    const body = await parseJsonBody(request, bodySchema);
    const now = new Date();
    const { user, created } = await auth.verifyCode({
      phoneE164: body.phone,
      codeId: body.codeId,
      code: body.code,
      address: clientAddress(request.headers, env.trustedProxyHops),
      displayName: body.displayName,
      now,
    });
    const session = issueSession(user.id, env.sessionSecret, now);
    return ok(
      { user: toPublicProfile(user), created, sessionExpiresAt: session.expiresAt.toISOString() },
      { headers: { 'set-cookie': sessionCookieHeader(session.token, { secure: env.nodeEnv === 'production' }) } },
    );
  });
}
