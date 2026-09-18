import { redirect } from 'next/navigation';

/** The console opens on the contest browser; the rail has the rest. */
export default function Home() {
  redirect('/contests');
}
