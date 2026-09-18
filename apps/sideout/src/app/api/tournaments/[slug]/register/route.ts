import { requireUser } from '../../../../../server/auth/current-user';
import { appContext } from '../../../../../server/context';
import type { RouteContext } from '../../../../../server/http/input';
import { parseJsonBody } from '../../../../../server/http/input';
import { handle, ok, type RequestContext } from '../../../../../server/http/respond';
import { centsToJson } from '../../../../../server/money';
import { registerTeam, registerTeamSchema } from '../../../../../server/registration';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Register a complete team: reserves the spot and starts the entry donation through the
 * configured provider. The Purse contest entry is phase 7 (`purseEntry.status` says so).
 */
export async function POST(request: Request, context: RouteContext<{ slug: string }>): Promise<Response> {
  return handle(request, async ({ requestId, log }: RequestContext) => {
    const { db, env, donationProvider, purseEntry } = appContext();
    const now = new Date();
    const user = await requireUser(request, { db, sessionSecret: env.sessionSecret, now });
    const { slug } = await context.params;
    const body = await parseJsonBody(request, registerTeamSchema);
    const result = await registerTeam(
      { db, provider: donationProvider, purseEntry, log },
      { tournamentSlug: slug, teamId: body.teamId, user, requestId, now },
    );
    return ok(
      {
        team: { id: result.team.id, name: result.team.name, status: result.team.status, registeredAt: result.team.registeredAt?.toISOString() ?? null },
        donation:
          result.donation === null
            ? null
            : {
                id: result.donation.id,
                amountCents: centsToJson(result.donation.amountCents),
                currency: result.donation.currency,
                provider: result.donation.provider,
                status: result.donation.status,
              },
        clientSecret: result.clientSecret,
        purseEntry: result.purseEntry,
      },
      { status: 201 },
    );
  });
}
