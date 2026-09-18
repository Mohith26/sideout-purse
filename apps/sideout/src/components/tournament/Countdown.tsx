'use client';

import { useEffect, useState } from 'react';

import { countdownParts } from '../../lib/format';

/**
 * Time until an event starts. Renders the server's request time first so hydration
 * matches, then re-reads the clock on an interval. Minute resolution means the first tick
 * is never more than 30s stale.
 */
export function Countdown({ targetIso, initialNowMs }: { targetIso: string; initialNowMs: number }) {
  const [now, setNow] = useState(initialNowMs);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const parts = countdownParts(targetIso, now);
  if (parts === null) return <span className="type-label text-text-tertiary">Starting</span>;
  const { days, hours, minutes } = parts;
  return (
    <span className="tabular type-label text-text-secondary">
      Starts in{' '}
      <span className="text-text-primary">
        {days > 0 ? `${days}d ` : ''}
        {hours}h {minutes}m
      </span>
    </span>
  );
}
