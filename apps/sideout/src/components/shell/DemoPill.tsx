import { Icons } from '@sideout/ui';

/**
 * The shell's marker for a session opened through the demo-accounts picker (`via: 'demo'`
 * in the cookie, `docs/demo-accounts.md`): every screen of such a session says so, in the
 * corner, until sign-out. Rendered by `SideoutShell` only for those sessions. Fault red on
 * purpose: it is a warning that this is a demo identity, not a status.
 */
export function DemoPill({ displayName }: { displayName: string }) {
  return (
    <div
      data-testid="demo-pill"
      role="status"
      aria-label={`Demo session as ${displayName}`}
      className="type-label pointer-events-none fixed top-3 right-3 z-40 inline-flex h-7 max-w-[60vw] items-center gap-1.5 rounded-full border border-fault/50 bg-bg-base/95 px-2.5 text-fault lg:top-4 lg:right-4"
    >
      <Icons.flag size={12} />
      <span className="truncate">
        Demo · <span className="text-text-secondary">{displayName}</span>
      </span>
    </div>
  );
}
