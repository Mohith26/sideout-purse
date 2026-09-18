'use client';

import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';

import { flipMoves, playFlip, snapshotRows, type FlipSnapshot } from './flip';
import { motionDurationMs, motionToken, prefersReducedMotion } from './reduced-motion';

/**
 * Wraps server-rendered rows that carry `data-team-id` (and `data-rank`) and plays the
 * standings reorder (spec 6.3, transition 2) whenever they re-render in a different order:
 * the positions from the previous commit are the "first", the positions after this commit
 * are the "last", and each moved row slides from one to the other. The rows themselves
 * stay server-rendered; nothing here holds a second copy of the standings.
 */
export type FlipRowsProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** Selector for the rows to track, relative to this wrapper. */
  rowSelector?: string;
  /** Test hook: report the moves that were played. */
  onFlip?: (moved: string[]) => void;
};

const DEFAULT_SELECTOR = '[data-team-id]';

export function FlipRows({ children, rowSelector = DEFAULT_SELECTOR, onFlip, ...rest }: FlipRowsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<FlipSnapshot | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(rowSelector));
    const keyOf = (el: HTMLElement) => el.dataset['teamId'] ?? null;
    const now = snapshotRows(rows, keyOf);
    const before = last.current;
    last.current = now;
    if (before === null) return;
    const moves = flipMoves(before, now);
    if (moves.length === 0) return;
    const byKey = new Map(rows.map((el) => [keyOf(el) ?? '', el]));
    playFlip(byKey, moves, { durationMs: motionDurationMs('--d-base'), easing: motionToken('--ease-out-expo'), reducedMotion: prefersReducedMotion() });
    onFlip?.(moves.map((m) => m.key));
  });

  return (
    <div ref={ref} data-flip-rows="" {...rest}>
      {children}
    </div>
  );
}
