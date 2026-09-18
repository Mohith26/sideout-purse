import type { ReactNode } from 'react';

export type AppShellProps = {
  /** Wordmark or logo, rendered as the header's leading element. */
  brand: ReactNode;
  /** Header actions or navigation, rendered trailing. */
  nav?: ReactNode;
  footer?: ReactNode;
  /** The left rail at 1280px and up (`NavRail`); the header hides when it shows. */
  rail?: ReactNode;
  /** The bottom tab bar below 1280px (`TabBar`); the content column clears it. */
  tabBar?: ReactNode;
  /** A status line above the content (connectivity, a queued submission). */
  status?: ReactNode;
  children: ReactNode;
};

/**
 * The page frame every screen sits in: a sticky hairline header, a content column capped
 * at the content width with 16px gutters at 390px (32px from 1280px), and an optional
 * footer. With `rail` and `tabBar` it is the mobile-first shell of spec 6.3: the tab bar
 * on a phone, the rail from 1280px, and a skip link to the main landmark first in the tab
 * order (spec 6.4).
 */
export function AppShell({ brand, nav, footer, rail, tabBar, status, children }: AppShellProps) {
  const classes = ['so-shell', rail === undefined ? '' : 'so-shell--rail', tabBar === undefined ? '' : 'so-shell--tabs'].filter((c) => c !== '').join(' ');
  return (
    <div className={classes}>
      {rail === undefined && tabBar === undefined ? null : (
        <a href="#main" className="so-skip-link">
          Skip to content
        </a>
      )}
      {rail}
      <header className="so-shell__header">
        <div className="so-shell__bar">
          {brand}
          {nav === undefined ? null : <nav className="so-shell__nav">{nav}</nav>}
        </div>
      </header>
      {status === undefined ? null : <div className="so-shell__status">{status}</div>}
      <main id="main" className="so-shell__main">
        {children}
      </main>
      {footer === undefined ? null : (
        <footer className="so-shell__footer">
          <div>{footer}</div>
        </footer>
      )}
      {tabBar}
    </div>
  );
}
