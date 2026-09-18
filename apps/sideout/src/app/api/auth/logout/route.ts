import { clearSessionCookieHeader } from '../../../../server/auth/session';
import { appContext } from '../../../../server/context';
import { handle, ok } from '../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Clear the session cookie. Sessions are stateless, so there is nothing to revoke server side. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, () => {
    const { env } = appContext();
    return Promise.resolve(ok({ signedOut: true }, { headers: { 'set-cookie': clearSessionCookieHeader({ secure: env.nodeEnv === 'production' }) } }));
  });
}
