'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * A hold on live refreshes (docs/live.md). A screen that is showing the reader a
 * confirmation of what they just did (the score sheet's "waiting on", "both teams agree" or
 * "scorelines differ" beat, the dispute card's "settled by") keeps it until they dismiss it;
 * a live event landing meanwhile would re-render the page from the server and, since the
 * row the confirmation belongs to has moved on, unmount the confirmation mid-beat. While any
 * hold is active `LiveRefresh` defers the refresh and runs it once the last hold is released
 * (the dismissal's own `router.refresh()` usually gets there first). Per page, in memory.
 */
const holds = new Set<symbol>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isLiveHeld(): boolean {
  return holds.size > 0;
}

export function subscribeLiveHold(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hold live refreshes while `active`; released on unmount. */
export function useLiveHold(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const key = Symbol('live-hold');
    holds.add(key);
    notify();
    return () => {
      holds.delete(key);
      notify();
    };
  }, [active]);
}

/** Whether a hold is active, for a component that renders differently while one is (tests). */
export function useLiveHeld(): boolean {
  return useSyncExternalStore(subscribeLiveHold, isLiveHeld, () => false);
}
