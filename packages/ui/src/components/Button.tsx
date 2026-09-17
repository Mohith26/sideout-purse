import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the control and announces busy state. */
  loading?: boolean;
  children: ReactNode;
};

/**
 * The one action primitive. `primary` is volt and there should be one of it per screen;
 * `danger` is reserved for destructive confirms and is never the default action.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      {...rest}
      type={type}
      className={className === undefined ? 'so-btn' : `so-btn ${className}`}
      data-variant={variant}
      data-size={size}
      disabled={isDisabled}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="so-btn__spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}
