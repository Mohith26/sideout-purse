'use client';

import { Button, Notice } from '@sideout/ui';

/** A page's read failed with something other than 401: say so, offer a retry, never a stack. */
export default function ConsoleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="stack">
      <Notice tone="error" title="This page could not load">
        {error.message}
      </Notice>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
