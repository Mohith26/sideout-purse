import type { ReactNode } from 'react';
import { Icons, type IconName } from '@sideout/ui';

import { cx } from '../../lib/cx';

/**
 * An inline notice for a state the reader should take in before acting: a form error, a
 * step that is not available yet, a result. Tone pairs a colour with an icon and a role,
 * never colour alone.
 */
export type NoticeTone = 'info' | 'success' | 'attention' | 'error';

const TONE: Record<NoticeTone, { className: string; icon: IconName; iconClass: string; role: 'status' | 'alert' }> = {
  info: { className: 'surface-inset text-text-secondary', icon: 'info', iconClass: 'text-text-tertiary', role: 'status' },
  success: { className: 'border border-surf/40 bg-surf/10 text-text-primary', icon: 'circleCheck', iconClass: 'text-surf', role: 'status' },
  attention: { className: 'border border-fault/40 bg-fault/10 text-text-primary', icon: 'triangleAlert', iconClass: 'text-fault', role: 'alert' },
  error: { className: 'border border-fault/40 bg-fault/10 text-text-primary', icon: 'circleAlert', iconClass: 'text-fault', role: 'alert' },
};

export function Notice({ tone = 'info', title, children, className, testId }: { tone?: NoticeTone; title?: string | undefined; children?: ReactNode; className?: string | undefined; testId?: string | undefined }) {
  const spec = TONE[tone];
  const Icon = Icons[spec.icon];
  return (
    <div role={spec.role} data-testid={testId} data-tone={tone} className={cx('flex items-start gap-3 rounded-card p-3 md:p-4', spec.className, className)}>
      <span className={cx('mt-0.5 shrink-0', spec.iconClass)}>
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        {title === undefined ? null : <p className="font-medium text-text-primary">{title}</p>}
        {children === undefined ? null : <div className={cx(title !== undefined && 'mt-0.5')}>{children}</div>}
      </div>
    </div>
  );
}
