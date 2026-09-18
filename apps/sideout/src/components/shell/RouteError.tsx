'use client';

import { ActionButton, EmptyState } from '@sideout/ui';

/**
 * The one error state every `error.tsx` renders: what happened in plain words, the digest
 * to quote, and a retry that re-renders the segment. A nested boundary keeps its layout
 * (the event header, the console nav) so the reader knows where they are. The server
 * logged the error itself; the browser keeps quiet (spec 7: no stray console output).
 */
export function RouteError({ error, reset, where }: { error: Error & { digest?: string }; reset: () => void; where?: string }) {
  return (
    <div data-testid="route-error">
      <EmptyState
        level={1}
        icon="circleAlert"
        title={where === undefined ? 'Something went wrong loading this page' : `Something went wrong loading ${where}`}
        body={
          <>
            <p>The request failed on the server. Nothing you did caused it.</p>
            {error.digest === undefined ? null : (
              <p className="type-label text-text-tertiary">
                Reference <span className="tabular">{error.digest}</span>
              </p>
            )}
          </>
        }
        action={
          <ActionButton variant="primary" onClick={reset}>
            Try again
          </ActionButton>
        }
      />
    </div>
  );
}
