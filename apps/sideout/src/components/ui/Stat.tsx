import type { ReactNode } from 'react';

import { cx } from '../../lib/cx';

/** One figure on a raised card, inside a `<dl>`. Numbers are tabular; ember is only ever passed in for a charity figure. */
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ember' | 'surf' }) {
  return (
    <div className="surface-raised rounded-card p-4">
      <dt className="type-label text-text-tertiary">{label}</dt>
      <dd className={cx('tabular mt-1 font-medium', tone === 'ember' ? 'text-ember' : tone === 'surf' ? 'text-surf' : 'text-text-primary')}>{value}</dd>
      {hint === undefined ? null : <dd className="tabular type-label mt-0.5 text-text-tertiary">{hint}</dd>}
    </div>
  );
}
