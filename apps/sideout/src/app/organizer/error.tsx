'use client';

import { RouteError } from '../../components/shell/RouteError';

export default function OrganizerRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} where="the console" />;
}
