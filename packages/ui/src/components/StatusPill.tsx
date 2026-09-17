import type { HTMLAttributes, ReactNode } from 'react';

/**
 * `live` and `positive` are surf, `negative` is fault, `impact` is ember (charity and
 * impact only), `brand` is volt. Colour is never the only carrier: the label always says
 * what the tone means.
 */
export type StatusTone = 'neutral' | 'live' | 'positive' | 'negative' | 'impact' | 'brand';

export type StatusPillProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  tone?: StatusTone;
  /** Leading dot; on by default for `live`. The breathing animation arrives in phase 8. */
  dot?: boolean;
  children: ReactNode;
};

export function StatusPill({ tone = 'neutral', dot, className, children, ...rest }: StatusPillProps) {
  const showDot = dot ?? tone === 'live';
  return (
    <span
      {...rest}
      className={className === undefined ? 'so-pill' : `so-pill ${className}`}
      data-tone={tone}
    >
      {showDot ? <span className="so-pill__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
