import { describe, expect, it } from 'vitest';

import { applyTheme, luminance, themeVariables } from '../src/embed/theme';

/** Spec 4.8 rule 8: the init theme lands as custom properties over the shared tokens. */
describe('theme', () => {
  it('maps the spec example onto the tokens, deriving the dependent shades', () => {
    const variables = themeVariables({ accent: '#D7FF3E', surface: '#101216', radius: 10, font: 'Instrument Sans' });
    expect(variables['--volt']).toBe('#d7ff3e');
    expect(variables['--on-volt']).toBe('#08090b');
    expect(variables['--volt-dim']).toMatch(/^#[0-9a-f]{6}$/);
    expect(variables['--bg-base']).toBe('#101216');
    expect(variables['--bg-raised']).toMatch(/^#[0-9a-f]{6}$/);
    expect(variables['--radius-card']).toBe('10px');
    expect(variables['--radius-input']).toBe('8px');
    expect(variables['--font-ui']).toMatch(/^'Instrument Sans', /);
  });

  it('puts light text on a dark accent and leaves out what was not given', () => {
    expect(themeVariables({ accent: '#1a237e' })['--on-volt']).toBe('#f4f5f7');
    expect(themeVariables({ radius: 0 })).toEqual({ '--radius-card': '0px', '--radius-input': '2px', '--radius-chip': '2px' });
    expect(themeVariables(null)).toEqual({});
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#000000')).toBe(0);
  });

  it('applies to an element as inline custom properties', () => {
    const root = document.createElement('div');
    applyTheme(root, { accent: '#ff6b3d' });
    expect(root.style.getPropertyValue('--volt')).toBe('#ff6b3d');
    expect(root.style.getPropertyValue('--bg-base')).toBe('');
  });
});
