import type { Metadata } from 'next';
import Link from 'next/link';
import { LinkButton } from '@sideout/ui';

import { PurseCallsTable, type PurseCallRow } from '../../../components/admin/PurseCallsTable';
import { ConsoleNav } from '../../../components/organizer/ConsoleNav';
import { listPurseCalls } from '../../../purse';
import { organizerPageContext } from '../../../server/pages';
import { countDisputedMatches } from '../../../server/screens';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Purse calls' };

/** Every `purse_calls` row, newest first, with the full request and response (spec 5.3, item 7). Open this when an engineer asks how the integration behaves. */
export default async function AdminPursePage({ searchParams }: { searchParams: Promise<{ before?: string; subjectType?: string; subjectId?: string }> }) {
  const { app } = await organizerPageContext();
  const query = await searchParams;
  const subject = query.subjectType !== undefined && query.subjectId !== undefined ? { type: query.subjectType, id: query.subjectId } : undefined;
  const [page, disputes] = await Promise.all([listPurseCalls(app.db, { limit: 50, before: query.before, subject }), countDisputedMatches(app.db)]);
  const rows: PurseCallRow[] = page.calls.map((call) => ({
    id: call.id,
    requestId: call.requestId,
    method: call.method,
    path: call.path,
    idempotencyKey: call.idempotencyKey,
    subject: call.subject,
    status: call.status,
    responseStatus: call.responseStatus,
    replayed: call.replayed,
    durationMs: call.durationMs,
    error: call.error,
    startedAt: call.startedAt,
    request: call.request,
    response: call.response,
  }));
  const older = page.nextBefore === null ? null : `/admin/purse?before=${encodeURIComponent(page.nextBefore)}${subject === undefined ? '' : `&subjectType=${encodeURIComponent(subject.type)}&subjectId=${encodeURIComponent(subject.id)}`}`;
  return (
    <>
      <div className="-mx-gutter -mt-5 border-b border-border-subtle bg-bg-base md:-mt-6">
        <div className="mx-auto flex max-w-content items-center gap-4 px-gutter pt-3">
          <span className="type-label text-text-tertiary">Console</span>
          <ConsoleNav
            items={[
              { href: '/organizer/events', label: 'Events', icon: 'calendar' },
              { href: '/organizer/disputes', label: 'Disputes', icon: 'triangleAlert', badge: disputes },
              { href: '/admin/purse', label: 'Purse', icon: 'shieldCheck' },
            ]}
          />
        </div>
      </div>
      <div className="space-y-6 pt-6 md:pt-8">
        <div>
          <h1 className="type-display-l">Purse calls</h1>
          <p className="mt-1 text-text-secondary">
            Every request Sideout made to Purse at <code className="so-mono">{app.env.purse.apiUrl}</code>, newest first, with its idempotency key, request and response. Secrets are never stored.
            {subject === undefined ? '' : ` Filtered to ${subject.type} ${subject.id}.`}
          </p>
        </div>
        <PurseCallsTable calls={rows} timeZone="UTC" />
        {older === null ? null : (
          <LinkButton component={Link} variant="secondary" href={older}>
            Older calls
          </LinkButton>
        )}
      </div>
    </>
  );
}
