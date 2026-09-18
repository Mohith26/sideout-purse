import { z } from 'zod';

import { actorFor } from '../../../../../../server/actor';
import { requireOrganizer } from '../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../server/context';
import { drawRequestSchema, runDraw } from '../../../../../../server/draw';
import type { RouteContext } from '../../../../../../server/http/input';
import { parseJsonBody, parseQuery } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({ preview: z.literal('1').optional() });

/**
 * Run a draw stage (`pools` or `bracket`). `?preview=1` computes the same result without
 * writing anything, so the organizer console can show a live draw preview.
 */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now });
    const { id } = await context.params;
    const preview = parseQuery(request, querySchema).preview !== undefined;
    const body = await parseJsonBody(request, drawRequestSchema);
    const outcome = await runDraw(db, { tournamentId: id, request: body, preview, actor: actorFor(organizer), now });
    return ok(outcome, { status: preview ? 200 : 201 });
  });
}
