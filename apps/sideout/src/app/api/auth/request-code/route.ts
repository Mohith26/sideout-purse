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
 * Start phone sign-in: issue a one-time code and send it through the SMS seam. The
 * response carries the code's id, which `POST /api/auth/verify` must name, and when it
 * expires; a screen that requests again must keep the latest id and answer with the most
 * recent message (docs/decisions.md). Outside production the code itself is echoed too,
 * with that contract spelled out, so tests and local development need no inbox.
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
    return ok({
      codeId: result.codeId,
      expiresAt: result.expiresAt.toISOString(),
      ...(result.code === undefined ? {} : { code: result.code, hint: result.hint }),
    });
  });
}
