import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react';

import { Icons, type IconComponent, type IconName } from './icons';

/**
 * The phase 8 vocabulary (spec 5.3, 6), styled by `components.css` from the tokens alone:
 * the status pill, empty state, skeleton, toast, confirm dialog, bottom sheet, tab bar,
 * rail, live dot, icon button and section heading. Everything here renders the same on
 * either side; the stateful toast, dialog and sheet are `interactive.tsx`.
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---- Buttons -------------------------------------------------------------------------------

export type ActionButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

type ActionButtonBase = {
  variant?: ActionButtonVariant;
  /** 48px tall with subheading type: the one primary action of a screen. */
  large?: boolean;
  /** The label may wrap onto more lines; the button grows in height rather than widening the page. */
  wrap?: boolean;
  block?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  children: ReactNode;
};

export type ActionButtonProps = ActionButtonBase & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>;

type ButtonLook = { variant?: ActionButtonVariant | undefined; large?: boolean | undefined; wrap?: boolean | undefined; block?: boolean | undefined };

function buttonClass({ variant = 'secondary', large = false, wrap = false, block = false }: ButtonLook): string {
  return cx('so-button', `so-button--${variant}`, large && 'so-button--large', wrap && 'so-button--wrap', block && 'so-button--block');
}

/** `Button` with the phase 8 variants and icons; `primary` is volt and there is one per screen. */
export function ActionButton({ variant, large, wrap, block, iconStart, iconEnd, children, type = 'button', ...rest }: ActionButtonProps) {
  return (
    <button type={type} className={buttonClass({ variant, large, wrap, block })} {...rest}>
      {iconStart === undefined ? null : <span className="so-button__icon">{iconStart}</span>}
      <span>{children}</span>
      {iconEnd === undefined ? null : <span className="so-button__icon">{iconEnd}</span>}
    </button>
  );
}

/** The props a router's link component must take (Next's `Link` does); kept minimal so any router fits. */
export type LinkLikeProps = { href: string; className?: string; children?: ReactNode; prefetch?: boolean; 'aria-current'?: 'page'; 'aria-label'?: string; target?: string; rel?: string };
export type LinkLike = ComponentType<LinkLikeProps>;

export type LinkButtonProps = ActionButtonBase & {
  href: string;
  /** The router's link component (Next's `Link`); a plain anchor by default. */
  component?: LinkLike;
  prefetch?: boolean;
  'aria-label'?: string;
  target?: string;
  rel?: string;
};

/** A link styled as a button, for a navigation that reads as an action ("Create a team"). */
export function LinkButton({ variant, large, wrap, block, iconStart, iconEnd, children, href, component, prefetch, ...rest }: LinkButtonProps) {
  const className = buttonClass({ variant, large, wrap, block });
  const content = (
    <>
      {iconStart === undefined ? null : <span className="so-button__icon">{iconStart}</span>}
      <span>{children}</span>
      {iconEnd === undefined ? null : <span className="so-button__icon">{iconEnd}</span>}
    </>
  );
  if (component !== undefined) {
    const Component = component;
    return (
      <Component href={href} className={className} {...(prefetch === undefined ? {} : { prefetch })} {...rest}>
        {content}
      </Component>
    );
  }
  return (
    <a href={href} className={className} {...rest}>
      {content}
    </a>
  );
}

export type IconButtonProps = { label: string; raised?: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'aria-label'>;

/** A 44px square control with one icon, named by `label`. */
export function IconButton({ label, raised = false, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} title={label} className={cx('so-icon-button', raised && 'so-icon-button--raised')} {...rest}>
      {children}
    </button>
  );
}

// ---- Live dot and status pill ----------------------------------------------------------------

/** The 2s breathing dot (transition 6), on live indicators only. Decorative beside its label. */
export function LiveDot({ small = false }: { small?: boolean }) {
  return <span aria-hidden="true" data-live-dot="" className={cx('so-live-dot live-dot', small && 'so-live-dot--sm')} />;
}

export type PillTone = 'neutral' | 'muted' | 'live' | 'success' | 'attention';

export type PillSpec = { label: string; tone: PillTone; icon: IconName };

/** Status as a label plus an icon: colour is never the only carrier of meaning. The `live` tone alone breathes. */
export function StatusPill({ spec, size = 'md', title }: { spec: PillSpec; size?: 'sm' | 'md'; title?: string | undefined }) {
  const Icon: IconComponent = Icons[spec.icon];
  return (
    <span className={cx('so-pill', spec.tone !== 'neutral' && `so-pill--${spec.tone}`, size === 'sm' && 'so-pill--sm')} title={title} data-tone={spec.tone}>
      {spec.tone === 'live' ? (
        <LiveDot small={size === 'sm'} />
      ) : (
        <span className="so-pill__icon">
          <Icon size={size === 'sm' ? 12 : 14} />
        </span>
      )}
      {spec.label}
    </span>
  );
}

// ---- Empty state and section heading ---------------------------------------------------------

export type EmptyStateProps = {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  /** The heading level the title takes: 1 for a whole page, 2 under a page title, 3 (default) under a section heading. */
  level?: 1 | 2 | 3;
};

/** An honest empty or not-yet state: left-aligned, one sentence of what happens next, at most one action. */
export function EmptyState({ icon = 'info', title, body, action, level = 3 }: EmptyStateProps) {
  const Icon = Icons[icon];
  const Heading = `h${level}` as const;
  return (
    <div className="so-empty">
      <span className="so-empty__icon">
        <Icon size={20} />
      </span>
      <div className="so-empty__content">
        <Heading className="so-empty__title">{title}</Heading>
        {body === undefined ? null : <div className="so-empty__body">{typeof body === 'string' ? <p>{body}</p> : body}</div>}
        {action === undefined ? null : <div className="so-empty__action">{action}</div>}
      </div>
    </div>
  );
}

/** The label-style section heading every screen uses, with an optional trailing figure. */
export function SectionHeading({ id, children, aside, level = 2 }: { id?: string; children: ReactNode; aside?: ReactNode; level?: 2 | 3 }) {
  const Heading = `h${level}` as const;
  return (
    <div className="so-section-heading">
      <Heading id={id}>{children}</Heading>
      {aside === undefined ? null : <div className="so-section-heading__aside">{aside}</div>}
    </div>
  );
}

// ---- Skeleton ------------------------------------------------------------------------------

/** A loading placeholder block; screens compose shapes that match what loads. */
export function Skeleton({ width, height, pill = false, style }: { width?: string; height?: string; pill?: boolean; style?: Record<string, string> }) {
  return <div aria-hidden="true" className={cx('so-skeleton', pill && 'so-skeleton--pill')} style={{ width: width ?? '100%', height: height ?? '1rem', ...style }} />;
}

// ---- Tab bar and rail -------------------------------------------------------------------------

export type NavItem = { href: string; label: string; icon: IconName; active: boolean; badge?: number };

type NavProps = { items: readonly NavItem[]; component?: LinkLike; label?: string };

function NavLink({ item, component, className }: { item: NavItem; component: LinkLike | undefined; className: string }) {
  const Icon = Icons[item.icon];
  const content = (
    <>
      <span className="so-nav-icon" style={{ display: 'inline-flex' }}>
        <Icon size={20} />
      </span>
      <span>{item.label}</span>
      {item.badge !== undefined && item.badge > 0 ? <span className="so-nav-badge">{item.badge}</span> : null}
    </>
  );
  const props: LinkLikeProps = { href: item.href, className, ...(item.active ? { 'aria-current': 'page' as const } : {}) };
  if (component !== undefined) {
    const Component = component;
    return <Component {...props}>{content}</Component>;
  }
  return <a {...props}>{content}</a>;
}

/** The bottom tab bar below 1280px, with safe-area insets. Hidden when the rail shows. */
export function TabBar({ items, component, label = 'Primary' }: NavProps) {
  return (
    <nav aria-label={label} className="so-tabbar">
      <ul className="so-tabbar__list">
        {items.map((item) => (
          <li key={item.href} className="so-tabbar__item">
            <NavLink item={item} component={component} className="so-tabbar__link" />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The left rail at 1280px and up.
 *
 * `brandArt` is the rail's counterpart to `AppShell`'s `headerArt`: decorative art painted
 * behind the brand block so a tenant's skin reaches the desktop layout too, where the
 * header (and so the header art) is hidden. A tenant that passes nothing keeps the plain
 * rail.
 */
export function NavRail({ items, component, label = 'Primary', brand, brandArt, foot }: NavProps & { brand: ReactNode; brandArt?: ReactNode; foot?: ReactNode }) {
  return (
    <aside className="so-navrail">
      <div className={brandArt === undefined ? 'so-navrail__brand' : 'so-navrail__brand so-navrail__brand--art'}>
        {brandArt}
        {brand}
      </div>
      <nav aria-label={label} className="so-navrail__nav">
        <ul className="so-navrail__list">
          {items.map((item) => (
            <li key={item.href}>
              <NavLink item={item} component={component} className="so-navrail__link" />
            </li>
          ))}
        </ul>
      </nav>
      {foot === undefined ? null : <div className="so-navrail__foot">{foot}</div>}
    </aside>
  );
}

