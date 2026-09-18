import { z } from 'zod';

import { listPurseCalls } from '../../../../../purse';
import { requireOrganizer } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import { parseQuery } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().startsWith('pcl_').optional(),
  subjectType: z.enum(['tournament', 'match', 'user', 'team']).optional(),
  subjectId: z.string().optional(),
});

/** Every `purse_calls` row, newest first, with full request and response (spec 5.3 item 7). Organizers only. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now: new Date() });
    const query = parseQuery(request, querySchema);
    const subject = query.subjectType !== undefined && query.subjectId !== undefined ? { type: query.subjectType, id: query.subjectId } : undefined;
    return ok(await listPurseCalls(db, { limit: query.limit, before: query.before, subject }));
  });
}
