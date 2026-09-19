import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { REQUEST_ID_HEADER } from '@purse/types';

import { StatusReport } from '../../components/StatusReport';
import { loadStatusPage } from '../../server/status';

export const metadata: Metadata = { title: 'Status', robots: { index: true, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * The public status page (spec section 12, stretch item 5). Outside the console frame and
 * exempt from the session gate (`src/middleware.ts` opens exactly this path): no session
 * is read, no `/console/*` route is called, and the page renders the stored invariant
 * record read through `src/server/status.ts`.
 */
export default async function StatusPage() {
  const requestId = (await headers()).get(REQUEST_ID_HEADER) ?? undefined;
  const data = await loadStatusPage(requestId);
  return <StatusReport data={data} />;
}
