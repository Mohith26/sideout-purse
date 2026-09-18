import type { ApiError, EligibilityReason, RequiredAction } from '@purse/types';
import type { ReactNode } from 'react';

/** The few primitives the flows share, styled from the shared tokens in globals.css. */

export function Button({ children, variant = 'primary', ...rest }: { children: ReactNode; variant?: 'primary' | 'secondary' } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  return (
    <button type="button" className={`button button--${variant}`} {...rest}>
      {children}
    </button>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
    </div>
  );
}

export function Notice({ tone, title, children }: { tone: 'error' | 'positive' | 'info'; title: string; children?: ReactNode }) {
  return (
    <div className={`notice${tone === 'info' ? '' : ` notice--${tone}`}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice__title">{title}</span>
      {children === undefined ? null : <p className="notice__body">{children}</p>}
    </div>
  );
}

/** Minor units as a grouped integer; POINTS and CREDIT have no fraction (spec D3). */
export function formatMoney(minor: string): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}`;
}

export function Money({ amount, asset }: { amount: string; asset: string }) {
  return (
    <span className="tabular">
      {formatMoney(amount)} <span className="muted">{asset}</span>
    </span>
  );
}

/** Copy for the sealed eligibility variants (spec 4.5). The variant is the contract; this is presentation and may change. */
export const REASON_COPY: Record<EligibilityReason, string> = {
  under_minimum_age: 'You are under the minimum age for this contest.',
  region_not_permitted: 'This contest is not available where you are.',
  identity_unverified: 'Your identity has not been verified yet.',
  identity_rejected: 'Your identity could not be verified.',
  self_excluded: 'You have excluded yourself from play.',
  cooling_off: 'You are in a cooling-off period.',
  platform_blocked: 'Your account cannot enter contests.',
  insufficient_balance: 'Your balance does not cover the entry.',
  stake_limit_exceeded: 'The entry is above your stake limit.',
  velocity_limit_exceeded: 'You have entered too much recently.',
  region_unknown: 'We could not confirm where you are.',
  contest_not_open: 'This contest is not open for entries.',
  contest_full: 'This contest is full.',
};

export const ACTION_COPY: Record<RequiredAction, string> = {
  complete_identity: 'Verify your identity to continue.',
  provide_demographics: 'Add your name and date of birth to continue.',
  add_funds: 'Add funds to continue.',
  confirm_location: 'Confirm your location to continue.',
};

/** Render an API error: the sealed variants of `not_eligible` and `insufficient_funds` get their copy; everything else its message. */
export function ErrorNotice({ error }: { error: ApiError }) {
  const detail = error.detail as { reasons?: EligibilityReason[]; requiredAction?: RequiredAction } | undefined;
  if ((error.type === 'not_eligible' || error.type === 'insufficient_funds') && Array.isArray(detail?.reasons)) {
    return (
      <div className="notice notice--error" role="alert">
        <span className="notice__title">{error.type === 'insufficient_funds' ? 'Not enough funds' : 'Not eligible'}</span>
        <ul className="list">
          {detail.reasons.map((reason) => (
            <li key={reason} className="notice__body">
              {REASON_COPY[reason] ?? reason}
            </li>
          ))}
        </ul>
        {detail.requiredAction === undefined ? null : <p className="notice__body">{ACTION_COPY[detail.requiredAction] ?? detail.requiredAction}</p>}
      </div>
    );
  }
  return (
    <Notice tone="error" title={TITLE_BY_TYPE[error.type] ?? 'Something went wrong'}>
      {error.message}
    </Notice>
  );
}

const TITLE_BY_TYPE: Partial<Record<ApiError['type'], string>> = {
  authentication_error: 'Sign in again',
  permission_error: 'Not allowed',
  invalid_request: 'Check the details',
  invalid_state: 'Not right now',
  conflict: 'Already done',
  rate_limited: 'Slow down',
  internal_error: 'Something went wrong',
};
