import { eq } from 'drizzle-orm';

import { charities, tournaments } from '../../../../../db/schema';
import { actorFor } from '../../../../../server/actor';
import { requireOrganizer } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import type { RouteContext } from '../../../../../server/http/input';
import { parseJsonBody } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { countedTeams } from '../../../../../server/field';
import { toPublicTournament } from '../../../../../server/public-shape';
import { mirrorTournament, type MirrorOutcome } from '../../../../../server/purse/contests';
import { requirePurse } from '../../../../../server/purse/deps';
import { updateTournament, updateTournamentSchema } from '../../../../../server/tournaments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Edit fields and/or move the tournament through its state machine. Organizers only.
 * After a transition commits, Purse is brought into step (the contest created and opened,
 * locked and started, or voided); a Purse failure is audited and reported in `purse`,
 * never fatal to the transition, and the next step runs the same idempotent mirror again.
 */
export async function PATCH(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const { db, env } = app;
    const now = new Date();
    const organizer = await requireOrganizer(request, { db, sessionSecret: env.sessionSecret, now });
    const { id } = await context.params;
    const body = await parseJsonBody(request, updateTournamentSchema);
    const clock = { now, reservationTtlMs: env.reservationTtlMs };
    const result = await updateTournament(db, id, body, actorFor(organizer), clock);
    let purse: MirrorOutcome | null = null;
    if (result.transition !== null) {
      purse = app.purse === null ? { status: 'skipped', reason: 'Purse is not configured on this server' } : await mirrorTournament(requirePurse(app), { tournamentId: id, requestId, now, actor: actorFor(organizer) });
    }
    const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, id));
    const current = tournament ?? result.tournament;
    const [beneficiary] = await db.select().from(charities).where(eq(charities.id, current.beneficiaryId));
    if (beneficiary === undefined) throw new Error('beneficiary vanished');
    const teamCount = await countedTeams(db, current.id, clock);
    return ok({
      tournament: { ...toPublicTournament(current, beneficiary, teamCount), drawConfig: current.drawConfig },
      changedFields: result.changedFields,
      transition: result.transition,
      purse,
    });
  });
}
