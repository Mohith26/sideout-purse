import { redirect } from 'next/navigation';

import { SignInForm } from '../components/SignInForm';
import { pagePlayer } from '../server/auth/current-player';
import { appContext } from '../server/context';

export const dynamic = 'force-dynamic';

/** The front door: sign in with a name and the office code; a signed-in player goes to the ladder. */
export default async function HomePage() {
  const app = appContext();
  const player = await pagePlayer({ db: app.db, sessionSecret: app.env.sessionSecret, now: new Date() });
  if (player !== null) redirect('/ladder');
  return (
    <div className="mx-auto max-w-md py-8">
      <h1 className="type-display-l mb-2">The office ladder</h1>
      <p className="type-body mb-6 text-text-secondary">Sign in with your name and the office code. Challenge someone up to three places above you, agree the score, climb. Each season is one contest on Purse: the stake, the eligibility check and the payout all happen there.</p>
      <SignInForm />
    </div>
  );
}
