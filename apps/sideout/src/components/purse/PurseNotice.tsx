'use client';

import { ActionButton, Icons } from '@sideout/ui';

import { Notice } from '../ui/Notice';
import type { PurseUiState } from './eligibility';
import { usePurse } from './PurseGate';

/**
 * One rendering of a mapped Purse state: what the person sees and the one thing they can
 * do about it. A terminal refusal (spec 5.3, "Profile") is a plain explanation with a
 * support path and no retry; an action names the flow that resolves it; the rest offer a
 * retry when the caller has one.
 */
export function PurseNotice({ state, onRetry, supportHref, className }: { state: PurseUiState; onRetry?: (() => void) | undefined; supportHref: string; className?: string }) {
  const purse = usePurse();
  const tone = state.kind === 'terminal' ? 'attention' : state.kind === 'unavailable' ? 'error' : 'info';
  return (
    <Notice tone={tone} title={state.title} className={className} testId={`purse-notice-${state.kind}`}>
      <p>{state.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state.kind === 'action' ? (
          <ActionButton variant="secondary" disabled={purse.busy} onClick={() => void purse.open(state.flow).then((out) => (out.ok && out.result !== null && onRetry !== undefined ? onRetry() : undefined))}>
            {state.label}
          </ActionButton>
        ) : null}
        {(state.kind === 'retry' || state.kind === 'unavailable') && onRetry !== undefined ? (
          <ActionButton variant="secondary" disabled={purse.busy} onClick={onRetry}>
            Try again
          </ActionButton>
        ) : null}
        {state.kind === 'terminal' ? (
          <a href={supportHref} className="target inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt" target="_blank" rel="noreferrer noopener">
            <Icons.externalLink size={14} />
            Contact Purse support
          </a>
        ) : null}
      </div>
    </Notice>
  );
}
