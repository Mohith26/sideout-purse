import { Icons } from '@sideout/ui';

/** The consensus confirm (spec 6.3, transition 4): one decisive --surf check, one beat, not a celebration. */
export function ConfirmCheck({ label = 'Agreed' }: { label?: string }) {
  return (
    <span role="img" aria-label={label} data-testid="confirm-check" className="confirm-enter flex size-12 shrink-0 items-center justify-center rounded-pill bg-surf text-on-volt">
      <Icons.check size={26} strokeWidth={2} />
    </span>
  );
}
