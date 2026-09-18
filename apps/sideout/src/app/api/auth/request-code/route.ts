import { z } from 'zod';

import { clientAddress } from '../../../../server/auth/client-address';
import { phoneE164Schema } from '../../../../server/auth/phone';
import { appContext } from '../../../../server/context';
import { parseJsonBody } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.object({ phone: phoneE164Schema });

/**
 * Start phone sign-in: issue a one-time code and send it through the SMS seam. Outside
 * production the code is echoed in the response so tests and local development need no
 * inbox; in production the response says only when it expires.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { auth, env } = appContext();
    const body = await parseJsonBody(request, bodySchema);
    const result = await auth.requestCode({
      phoneE164: body.phone,
      address: clientAddress(request.headers, env.trustedProxyHops),
      now: new Date(),
    });
    return ok({ expiresAt: result.expiresAt.toISOString(), ...(result.code === undefined ? {} : { code: result.code }) });
  });
}
