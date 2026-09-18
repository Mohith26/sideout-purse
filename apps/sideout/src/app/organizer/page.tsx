import { redirect } from 'next/navigation';

import { organizerPageContext } from '../../server/pages';

export const dynamic = 'force-dynamic';

/** The console opens on the event list. */
export default async function OrganizerIndex() {
  await organizerPageContext();
  redirect('/organizer/events');
}
