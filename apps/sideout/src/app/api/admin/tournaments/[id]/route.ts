import { eq } from 'drizzle-orm';

import { charities } from '../../../../../db/schema';
import { actorFor } from '../../../../../server/actor';
import { requireOrganizer } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import type { RouteContext } from '../../../../../server/http/input';
import { parseJsonBody } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { toPublicTournament } from '../../../../../server/public-shape';
import { countedTeams, updateTournament, updateTournamentSchema } from '../../../../../server/tournaments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Edit fields and/or move the tournament through its state machine. Organizers only. */
export async function PATCH(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async () => {
    const { db, env } = appContext();
    const now = new Date();
    const organizer = await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now });
    const { id } = await context.params;
    const body = await parseJsonBody(request, updateTournamentSchema);
    const result = await updateTournament(db, id, body, actorFor(organizer), now);
    const [beneficiary] = await db.select().from(charities).where(eq(charities.id, result.tournament.beneficiaryId));
    if (beneficiary === undefined) throw new Error('beneficiary vanished');
    const teamCount = await countedTeams(db, result.tournament.id);
    return ok({
      tournament: { ...toPublicTournament(result.tournament, beneficiary, teamCount), drawConfig: result.tournament.drawConfig },
      changedFields: result.changedFields,
      transition: result.transition,
    });
  });
}
