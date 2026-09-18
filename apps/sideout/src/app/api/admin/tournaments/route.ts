import { eq } from 'drizzle-orm';

import { charities } from '../../../../db/schema';
import { actorFor } from '../../../../server/actor';
import { requireOrganizer } from '../../../../server/auth/current-user';
import { appContext } from '../../../../server/context';
import { parseJsonBody } from '../../../../server/http/input';
import { handle, ok } from '../../../../server/http/respond';
import { toPublicTournament } from '../../../../server/public-shape';
import { createTournament, createTournamentSchema } from '../../../../server/tournaments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Create a tournament in `draft`. Organizers only. */
export async function POST(request: Request): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now });
    const body = await parseJsonBody(request, createTournamentSchema);
    const tournament = await createTournament(db, body, actorFor(organizer), now);
    const [beneficiary] = await db.select().from(charities).where(eq(charities.id, tournament.beneficiaryId));
    if (beneficiary === undefined) throw new Error('beneficiary vanished');
    return ok({ tournament: { ...toPublicTournament(tournament, beneficiary, 0), drawConfig: tournament.drawConfig } }, { status: 201 });
  });
}
