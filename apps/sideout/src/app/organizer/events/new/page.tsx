import { asc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Icons } from '@sideout/ui';

import { EventForm, type EventFormValues } from '../../../../components/organizer/EventForm';
import { charities, DIVISIONS } from '../../../../db/schema';
import { DRAWABLE_FORMATS } from '../../../../domain/draw';
import { organizerPageContext } from '../../../../server/pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'New event' };

const DEFAULT_TZ = 'America/Los_Angeles';

function localDefault(daysAhead: number, hour: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00`;
}

/** The event builder, create mode (spec 5.3, item 6): a draft that the status controls then open. */
export default async function NewEventPage() {
  const { app } = await organizerPageContext();
  const beneficiaries = await app.db.select({ id: charities.id, name: charities.name }).from(charities).where(eq(charities.status, 'active')).orderBy(asc(charities.name));
  const initial: EventFormValues = {
    slug: '',
    name: '',
    subtitle: '',
    beneficiaryId: beneficiaries[0]?.id ?? '',
    venueName: '',
    venueCity: '',
    venueRegion: '',
    venueTimezone: DEFAULT_TZ,
    startsAt: localDefault(30, 9),
    endsAt: localDefault(30, 17),
    format: 'pool_to_bracket',
    division: 'open',
    maxTeams: '16',
    entryDonation: '40',
    fundraisingGoal: '2500',
  };
  return (
    <div className="space-y-6">
      <div>
        <Link href="/organizer/events" className="target inline-flex items-center gap-1 rounded-input type-label text-text-secondary hover:text-text-primary">
          <Icons.chevronLeft size={14} />
          Events
        </Link>
        <h1 className="type-display-l">New event</h1>
        <p className="mt-1 text-text-secondary">Created as a draft. Open registration from the builder when it is ready; the Purse contest is created at that moment.</p>
      </div>
      <EventForm mode="create" options={{ formats: DRAWABLE_FORMATS, divisions: DIVISIONS, charities: beneficiaries, defaultTimeZone: DEFAULT_TZ }} initial={initial} locks={{ readOnly: false, draftOnly: true, minTeams: 0 }} />
    </div>
  );
}
