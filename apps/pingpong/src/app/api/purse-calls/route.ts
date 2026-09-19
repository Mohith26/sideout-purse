import { z } from 'zod';

import { listPurseCalls } from '../../../purse';
import { parseQuery } from '../../../server/http/input';
import { handle, ok } from '../../../server/http/respond';
import { signedIn } from '../../../server/route-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().min(1).optional() });

/** The Purse call audit, newest first: what was asked, what came back, how long it took. Bodies are not on the wire; they stay in the table. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { app } = await signedIn(request);
    const query = parseQuery(request, querySchema);
    return ok(await listPurseCalls(app.db, { limit: query.limit, before: query.before }));
  });
}
