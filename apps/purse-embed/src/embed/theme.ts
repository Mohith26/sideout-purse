import type { Theme } from '@purse/types';

/**
 * Spec 4.8 rule 8: the theme the partner passed at init, applied as CSS custom properties
 * over the shared tokens (`@sideout/ui/tokens.css`) so the flow looks native in the
 * partner's page. Each field maps onto the token it stands for; a field left out keeps
 * the token's own value. The values were validated by `themeSchema` before they got here
 * (a six-digit colour, a small integer radius, a plain font name), so nothing set here
 * can carry a declaration of its own.
 */
export type ThemeVariables = Record<string, string>;

/** Relative luminance (WCAG) of a six-digit hex colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Lighten or darken a hex colour by mixing it with white or black. */
function mix(hex: string, towards: 0 | 255, amount: number): string {
  const part = (offset: number): string => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(value + (towards - value) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${part(1)}${part(3)}${part(5)}`;
}

export function themeVariables(theme: Theme | null): ThemeVariables {
  const variables: ThemeVariables = {};
  if (theme === null) return variables;
  if (theme.accent !== undefined) {
    const accent = theme.accent.toLowerCase();
    variables['--volt'] = accent;
    variables['--volt-dim'] = mix(accent, 0, 0.22);
    // Text on the accent stays readable whichever way the partner leans.
    variables['--on-volt'] = luminance(accent) > 0.4 ? '#08090b' : '#f4f5f7';
  }
  if (theme.surface !== undefined) {
    const surface = theme.surface.toLowerCase();
    variables['--bg-base'] = surface;
    variables['--bg-raised'] = mix(surface, 255, 0.04);
    variables['--bg-overlay'] = mix(surface, 255, 0.08);
    variables['--bg-inset'] = mix(surface, 0, 0.3);
    variables['--border-subtle'] = mix(surface, 255, 0.12);
    variables['--border-strong'] = mix(surface, 255, 0.22);
  }
  if (theme.radius !== undefined) {
    variables['--radius-card'] = `${theme.radius}px`;
    variables['--radius-input'] = `${Math.max(2, Math.min(theme.radius, 8))}px`;
    variables['--radius-chip'] = `${Math.max(2, Math.min(theme.radius, 4))}px`;
  }
  if (theme.font !== undefined) {
    variables['--font-ui'] = `'${theme.font.replace(/'/g, '')}', var(--font-instrument-sans, 'Instrument Sans'), ui-sans-serif, system-ui, sans-serif`;
  }
  return variables;
}

export function applyTheme(root: HTMLElement, theme: Theme | null): void {
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value);
}
