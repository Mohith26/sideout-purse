import { eq } from 'drizzle-orm';

import { sets } from '../../../../../db/schema';
import { submittedAttestationSchema } from '../../../../../domain/attestation';
import { submittedScorelineSchema } from '../../../../../domain/consensus';
import { SYSTEM_ACTOR } from '../../../../../server/actor';
import { requireUser } from '../../../../../server/auth/current-user';
import { consensusView, submitScoreline } from '../../../../../server/consensus';
import { appContext } from '../../../../../server/context';
import type { RouteContext } from '../../../../../server/http/input';
import { parseJsonBody } from '../../../../../server/http/input';
import { handle, ok } from '../../../../../server/http/respond';
import { toPublicMatch } from '../../../../../server/public-shape';
import { pushAfterAgreed } from '../../../../../server/purse/after-commit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The scoreline from the submitter's side, plus the phone's signature over it when the phone is checked in (spec section 12, item 1). */
const bodySchema = submittedScorelineSchema.extend({ attestation: submittedAttestationSchema.nullable().optional() });

/**
 * A player's scoreline for their match, from their own side of the net (spec 5.2). The
 * consensus decides `awaiting_second`, `agreed` or `disputed`; on `agreed` the scores are
 * pushed to Purse after the transaction commits, and the answer says how far that got. A
 * signature that is present but fails its check refuses the submission with
 * `invalid_attestation` (422); a submission with none is accepted as before.
 */
export async function POST(request: Request, context: RouteContext<{ id: string }>): Promise<Response> {
  return handle(request, async ({ requestId }) => {
    const app = appContext();
    const now = new Date();
    const user = await requireUser(request, { db: app.db, sessionSecret: app.env.sessionSecret, now });
    const { id } = await context.params;
    const { attestation, ...scoreline } = await parseJsonBody(request, bodySchema);
    const result = await submitScoreline(app.db, { matchId: id, user, scoreline, attestation: attestation ?? null, now });
    // The push is the platform's act, not the player's: it runs as the system.
    const purse = result.outcome === 'agreed' ? await pushAfterAgreed(app, { matchId: id, actor: SYSTEM_ACTOR, requestId, now }) : null;
    const setRows = result.outcome === 'agreed' ? await app.db.select().from(sets).where(eq(sets.matchId, id)) : [];
    return ok({
      outcome: result.outcome,
      replaced: result.replaced,
      submissionId: result.submissionId,
      perspective: result.perspective,
      match: toPublicMatch(result.match, setRows),
      consensus: await consensusView(app.db, id),
      purse,
    });
  });
}
