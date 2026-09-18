'use client';

import { RouteError } from '../../../components/shell/RouteError';

export default function MatchRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} where="this match" />;
}
