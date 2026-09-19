import { z } from 'zod';

import { requireOrganizer } from '../../../../../../server/auth/current-user';
import { appContext } from '../../../../../../server/context';
import { deviceView, mirrorAfterCommit, mirrorRevocationToPurse, revokeTeamDevice } from '../../../../../../server/devices';
import type { RouteContext } from '../../../../../../server/http/input';
import { parseJsonBody } from '../../../../../../server/http/input';
import { handle, ok } from '../../../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ reason: z.string().trim().min(1).max(500).nullable().optional() });

/**
 * Revoke a checked-in phone (spec section 12, item 1). Organizers only. A scoreline that
 * phone signed is refused from now on, queued ones included; the revocation is mirrored to
 * Purse after it commits unless the same key is still live for the player elsewhere.
 */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const body = await parseJsonBody(request, bodySchema);
    const { device, revoked } = await revokeTeamDevice(app.db, { deviceId: id, organizer, reason: body.reason ?? null, now });
    const mirror = revoked ? await mirrorAfterCommit(app, (deps) => mirrorRevocationToPurse(deps, device, { requestId, now })) : { status: 'skipped' as const, reason: 'Already revoked.' };
    return ok({ device: deviceView(device), revoked, mirror });
  });
}
