import { and, eq } from 'drizzle-orm';

import { teamMembers } from '../../../../../db/schema';
import { requireUser } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import { deviceView, listTeamDevices, mirrorAfterCommit, mirrorDeviceToPurse, registerDeviceSchema, registerTeamDevice } from '../../../../../server/devices';
import { failure } from '../../../../../server/http/errors';
import type { RouteContext } from '../../../../../server/http/input';
import { parseJsonBody } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Check a phone in for the signed-in member's team (spec section 12, item 1): the phone's
 * public key is registered under its thumbprint, and, once Sideout's row has committed,
 * mirrored to Purse for the member's linked user. The mirror never fails the check-in; the
 * answer says how it went.
 */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const body = await parseJsonBody(request, registerDeviceSchema);
    const { device, created } = await registerTeamDevice(app.db, { teamId: id, user, publicKey: body.publicKey, now });
    const mirror = device.purseDeviceId === null ? await mirrorAfterCommit(app, (deps) => mirrorDeviceToPurse(deps, device, { requestId, now })) : { status: 'mirrored' as const };
    const devices = await listTeamDevices(app.db, [id]);
    return ok({ device: deviceView(devices.find((d) => d.id === device.id) ?? device), created, mirror, devices: devices.map(deviceView) }, { status: created ? 201 : 200 });
  });
}

/** The phones checked in for a team, for a member of it or an organizer. */
export async function GET(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    if (user.role !== 'organizer') {
      const [member] = await app.db.select({ id: teamMembers.id }).from(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, user.id)));
      if (member === undefined) throw failure.permission('not_on_team', 'Only a member of the team or an organizer can see its devices.');
    }
    return ok({ devices: (await listTeamDevices(app.db, [id])).map(deviceView) });
  });
}
