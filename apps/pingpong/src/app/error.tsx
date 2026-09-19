'use client';

import { ActionButton, Notice } from '@sideout/ui';

/** The route error boundary: what broke, never the stack, and a way back. */
export default function ErrorScreen({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md py-8">
      <Notice tone="error" title="Something went wrong">
        The page could not load. Try again; if it keeps happening, tell whoever runs the ladder.
      </Notice>
      <div className="mt-4">
        <ActionButton variant="secondary" onClick={reset}>
          Try again
        </ActionButton>
      </div>
    </div>
  );
}
