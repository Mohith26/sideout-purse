'use client';

import { RouteError } from '../../../components/shell/RouteError';

export default function TournamentRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} where="this event" />;
}
