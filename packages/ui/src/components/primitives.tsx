import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * The primitives the operator console is built from (spec 4.10, "the same design system
 * with denser layout"), styled by `components.css` from the tokens alone. Each is a thin,
 * unopinionated wrapper: the class names are the API, so a consumer that prefers plain
 * markup can use them directly.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export type ButtonProps = { variant?: ButtonVariant; small?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>;

export function Button({ variant = 'secondary', small = false, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`so-button so-button--${variant}${small ? ' so-button--small' : ''}`} {...rest} />;
}

export type ChipTone = 'neutral' | 'surf' | 'fault' | 'volt' | 'ember' | 'muted';

export function Chip({ tone = 'neutral', children, title }: { tone?: ChipTone; children: ReactNode; title?: string | undefined }) {
  return (
    <span className={`so-chip${tone === 'neutral' ? '' : ` so-chip--${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export type NoticeTone = 'info' | 'error' | 'positive' | 'warning';

export function Notice({ tone = 'info', title, children }: { tone?: NoticeTone; title: string; children?: ReactNode }) {
  return (
    <div className={`so-notice${tone === 'info' ? '' : ` so-notice--${tone}`}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="so-notice__title">{title}</span>
      {children === undefined ? null : <div className="so-notice__body">{children}</div>}
    </div>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="so-field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : <span className="so-field__hint">{hint}</span>}
    </div>
  );
}

export function Input(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <input className="so-input" {...props} />;
}

export function Select(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>) {
  return <select className="so-select" {...props} />;
}

export function Textarea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  return <textarea className="so-textarea" {...props} />;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="so-card">
      {title === undefined && actions === undefined ? null : (
        <div className="so-card__head">
          {title === undefined ? <span /> : <h2 className="so-card__title">{title}</h2>}
          {actions === undefined ? null : <div className="so-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A definition list on a two-column grid: labels uppercase, values tabular. */
export function KeyValue({ items }: { items: Array<{ key: string; value: ReactNode }> }) {
  return (
    <dl className="so-kv">
      {items.map((item) => (
        <div key={item.key} style={{ display: 'contents' }}>
          <dt>{item.key}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'fault' | 'surf' }) {
  return (
    <div className="so-stat">
      <span className={`so-stat__value${tone === undefined ? '' : ` so-stat__value--${tone}`}`}>{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}

/** An id, a hash, a key prefix: monospace and breakable. */
export function Mono({ children, title }: { children: ReactNode; title?: string | undefined }) {
  return (
    <span className="so-mono" title={title}>
      {children}
    </span>
  );
}

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Right-aligned tabular digits. */
  numeric?: boolean;
  /** Never wraps (an instant, a short id). */
  nowrap?: boolean;
  render: (row: T) => ReactNode;
};

function cellClass<T>(column: Column<T>): string | undefined {
  const classes = [column.numeric ? 'so-num' : '', column.nowrap ? 'so-nowrap' : ''].filter((each) => each !== '');
  return classes.length === 0 ? undefined : classes.join(' ');
}

/** A dense table: every column declared, every row keyed, an explicit empty state. */
export function DataTable<T>({ columns, rows, rowKey, empty = 'Nothing here yet.', caption }: { columns: Array<Column<T>>; rows: readonly T[]; rowKey: (row: T) => string; empty?: string; caption?: string }) {
  return (
    <div className="so-table-wrap">
      <table className="so-table">
        {caption === undefined ? null : <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={cellClass(column)}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="so-table__empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key} className={cellClass(column)}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Minor units as a grouped integer with a Unicode minus; POINTS and CREDIT have no fraction (decision D3). Never a float. */
export function formatMoney(minor: string | bigint): string {
  const text = typeof minor === 'bigint' ? minor.toString() : minor;
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}`;
}

export function Money({ amount, asset, signed = false }: { amount: string | bigint; asset?: string | undefined; signed?: boolean }) {
  const text = typeof amount === 'bigint' ? amount.toString() : amount;
  const positive = signed && !text.startsWith('-') && text !== '0';
  return (
    <span className="tabular">
      {positive ? '+' : ''}
      {formatMoney(text)}
      {asset === undefined ? null : <span className="label" style={{ marginLeft: '0.35em' }}>{asset}</span>}
    </span>
  );
}
