import type { ReactNode } from 'react';

/**
 * The few primitives phase 7's screens share, on the `@sideout/ui` tokens: a card, a
 * label, a status chip, a button and a notice. Phase 8 builds the real screen set; these
 * keep the score sheet, the dispute queue, the close page and `/admin/purse` legible and
 * consistent until then.
 */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-card border border-border-subtle bg-bg-raised p-4 md:p-6 ${className}`}>{children}</section>;
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="label text-text-secondary">{children}</span>;
}

export type Tone = 'neutral' | 'live' | 'positive' | 'warning' | 'error';

const TONES: Record<Tone, string> = {
  neutral: 'border-border-strong text-text-secondary',
  live: 'border-surf text-surf',
  positive: 'border-surf text-surf',
  warning: 'border-volt-dim text-volt',
  error: 'border-fault text-fault',
};

export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`label inline-flex items-center rounded-chip border px-2 py-1 ${TONES[tone]}`}>{children}</span>;
}

export function Notice({ tone = 'neutral', title, children }: { tone?: Tone; title: string; children?: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-input border bg-bg-inset p-4 ${TONES[tone]}`}>
      <p className="text-subheading text-text-primary">{title}</p>
      {children === undefined ? null : <div className="mt-1 text-body text-text-secondary">{children}</div>}
    </div>
  );
}

export function Button({ children, primary = false, ...props }: { children: ReactNode; primary?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = 'inline-flex min-h-11 items-center justify-center rounded-input px-4 text-body font-semibold transition-colors duration-[var(--d-micro)] disabled:cursor-not-allowed disabled:opacity-50';
  const look = primary ? 'bg-volt text-on-volt hover:bg-volt-dim' : 'border border-border-strong text-text-primary hover:border-text-tertiary';
  return (
    <button type="button" {...props} className={`${base} ${look} ${props.className ?? ''}`}>
      {children}
    </button>
  );
}

/** A consensus or Purse state as a chip, in the tone the state deserves. */
export function StateChip({ state }: { state: string | null }) {
  const tone: Tone = state === null ? 'neutral' : state === 'disputed' ? 'error' : state === 'confirmed' ? 'positive' : state === 'agreed' || state === 'pushed_to_purse' ? 'warning' : 'neutral';
  return <Chip tone={tone}>{state === null ? 'not scored' : state.replace(/_/g, ' ')}</Chip>;
}

export function Pre({ value }: { value: unknown }) {
  return <pre className="max-w-full overflow-x-auto rounded-input bg-bg-inset p-3 text-[0.8125rem] leading-relaxed text-text-secondary">{JSON.stringify(value, null, 2)}</pre>;
}
