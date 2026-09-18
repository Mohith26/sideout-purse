'use client';

import { RouteError } from '../components/shell/RouteError';

export default function RootRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} />;
}
