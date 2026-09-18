import type { ReactNode } from 'react';

export type AppShellProps = {
  /** Wordmark or logo, rendered as the header's leading element. */
  brand: ReactNode;
  /** Header actions or navigation, rendered trailing. */
  nav?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
};

/**
 * The page frame every screen sits in: a sticky hairline header, a content column capped
 * at the content width with 16px gutters at 390px, and an optional footer.
 */
export function AppShell({ brand, nav, footer, children }: AppShellProps) {
  return (
    <div className="so-shell">
      <header className="so-shell__header">
        <div className="so-shell__bar">
          {brand}
          {nav === undefined ? null : <nav className="so-shell__nav">{nav}</nav>}
        </div>
      </header>
      <main className="so-shell__main">{children}</main>
      {footer === undefined ? null : (
        <footer className="so-shell__footer">
          <div>{footer}</div>
        </footer>
      )}
    </div>
  );
}
