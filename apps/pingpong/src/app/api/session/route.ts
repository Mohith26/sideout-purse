import { z } from 'zod';

import { appContext } from '../../../server/context';
import { currentPlayer } from '../../../server/auth/current-player';
import { clearSessionCookieHeader, issueSession, sessionCookieHeader } from '../../../server/auth/session';
import { parseJsonBody } from '../../../server/http/input';
import { handle, ok } from '../../../server/http/respond';
import { publicPlayer, signIn } from '../../../server/players';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const bodySchema = z.strictObject({ name: z.string().min(1).max(60), officeCode: z.string().min(1).max(100) });

/** Sign in with a name and the office code; a new name becomes a new player. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const app = appContext();
    const now = new Date();
    const body = await parseJsonBody(request, bodySchema);
    const { player, created } = await signIn(app.db, { name: body.name, officeCode: body.officeCode, expectedOfficeCode: app.env.officeCode, now });
    const { token } = issueSession(player.id, app.env.sessionSecret, now);
    return ok({ player: publicPlayer(player), created }, { status: created ? 201 : 200, headers: { 'set-cookie': sessionCookieHeader(token, { secure: app.env.nodeEnv === 'production' }) } });
  });
}

/** Who is signed in, or `{ player: null }`. */
export async function GET(request: Request): Promise<Response> {
  return handle(request, async () => {
    const app = appContext();
    const player = await currentPlayer(request, { db: app.db, sessionSecret: app.env.sessionSecret, now: new Date() });
    return ok({ player: player === null ? null : publicPlayer(player) });
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request, () => {
    const app = appContext();
    return Promise.resolve(ok({ player: null }, { headers: { 'set-cookie': clearSessionCookieHeader({ secure: app.env.nodeEnv === 'production' }) } }));
  });
}
