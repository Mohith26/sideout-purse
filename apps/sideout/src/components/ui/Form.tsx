'use client';

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Icons } from '@sideout/ui';

import { cx } from '../../lib/cx';

/**
 * Form vocabulary: a label, control, hint and error as one unit, with the error wired to
 * the control through `aria-describedby` and `aria-invalid`. Controls are 44px tall (spec
 * 6.4) on the inset surface; the volt focus ring comes from the global `:focus-visible`.
 */
export type FieldProps = {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  /** Rendered after the label, e.g. "optional". */
  meta?: string;
  children: (control: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
};

export function Field({ label, hint, error, meta, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId].filter((each) => each !== null).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="flex items-baseline justify-between gap-3 type-label text-text-secondary">
        <span>{label}</span>
        {meta === undefined ? null : <span className="normal-case tracking-normal text-text-tertiary">{meta}</span>}
      </label>
      {children({ id, describedBy, invalid: error !== undefined })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-text-tertiary">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-fault">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  'w-full min-h-11 rounded-input surface-inset px-3 text-body text-text-primary placeholder:text-text-tertiary transition-colors duration-(--d-micro) hover:border-border-strong focus:border-border-strong disabled:opacity-50 aria-invalid:border-fault';

export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export function TextInput({ className, invalid, ...rest }: TextInputProps) {
  return <input {...rest} aria-invalid={invalid === true ? true : undefined} className={cx(CONTROL, rest.type === 'number' && 'tabular', className)} />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean };

export function Select({ className, invalid, children, ...rest }: SelectProps) {
  return (
    <span className={cx('relative block', className)}>
      <select {...rest} aria-invalid={invalid === true ? true : undefined} className={cx(CONTROL, 'appearance-none pr-9')}>
        {children}
      </select>
      <Icons.chevronDown size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-text-secondary" />
    </span>
  );
}

export function Fieldset({ legend, description, children }: { legend: string; description?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="type-subheading text-text-primary">{legend}</legend>
      {description === undefined ? <div className="mb-4" /> : <p className="mt-1 mb-4 text-text-secondary">{description}</p>}
      {children}
    </fieldset>
  );
}
