'use client';

import { useEffect, useRef, useState } from 'react';

import { cx } from '../../lib/cx';
import { motionDurationMs, prefersReducedMotion } from './reduced-motion';

/**
 * A score that rolls to its new value (spec 6.3, transition 1): tabular digits so the
 * width never jitters, the number counted from the previous value to the new one over
 * --d-base with an expo ease-out, and the settled glyphs fading in over the last beat. The
 * first render shows the value as is; only a change rolls. Under reduced motion the number
 * changes at once and only the fade remains.
 */
export type ScoreDisplayProps = {
  value: number;
  className?: string;
  /** Test hook: the easing curve; defaults to an expo ease-out. */
  ease?: (t: number) => number;
};

export const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

export function ScoreDisplay({ value, className, ease = easeOutExpo }: ScoreDisplayProps) {
  const [shown, setShown] = useState(value);
  const [settleKey, setSettleKey] = useState(0);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    if (from === value) return;
    previous.current = value;
    setSettleKey((k) => k + 1);
    const duration = motionDurationMs('--d-base');
    if (prefersReducedMotion() || duration <= 0 || typeof requestAnimationFrame !== 'function') {
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      setShown(Math.round(from + (value - from) * ease(progress)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, ease]);

  return (
    <span key={settleKey} className={cx('score-roll', settleKey > 0 && 'score-settle', className)} data-rolling={shown !== value ? 'true' : undefined} data-value={value}>
      {shown}
    </span>
  );
}
