'use client';

/** The last resort when the root layout itself fails: plain markup, no shell, on the tokens' colours. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#fbf2df', color: '#172a45', fontFamily: 'ui-sans-serif, system-ui, sans-serif', padding: '24px' }}>
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Sideout could not load</h1>
        <p style={{ color: '#9ba3af' }}>The page failed before it could render. Nothing you did caused it.{error.digest === undefined ? '' : ` Reference ${error.digest}.`}</p>
        <button type="button" onClick={reset} style={{ minHeight: '44px', padding: '0 16px', borderRadius: '6px', border: 0, background: '#c33b22', color: '#ffffff', fontWeight: 600 }}>
          Try again
        </button>
      </body>
    </html>
  );
}
