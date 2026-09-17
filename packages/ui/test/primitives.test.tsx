import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AppShell, Button, StatusPill } from '../src/index';

const COMPONENTS_CSS = path.resolve(import.meta.dirname, '../src/styles/components.css');

describe('Button', () => {
  it.each(['primary', 'secondary', 'ghost', 'danger'] as const)('renders the %s variant', (variant) => {
    const html = renderToStaticMarkup(<Button variant={variant}>Enter</Button>);
    expect(html).toContain('class="so-btn"');
    expect(html).toContain(`data-variant="${variant}"`);
    expect(html).toContain('type="button"');
  });

  it('is secondary by default so volt has to be chosen deliberately', () => {
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain('data-variant="secondary"');
  });

  it('disables itself and announces busy while loading', () => {
    const html = renderToStaticMarkup(<Button loading>Saving</Button>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('so-btn__spinner');
  });

  it('keeps extra classes and native attributes', () => {
    const html = renderToStaticMarkup(
      <Button type="submit" className="w-full" aria-label="Submit entry">
        Submit
      </Button>,
    );
    expect(html).toContain('class="so-btn w-full"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('aria-label="Submit entry"');
  });
});

describe('StatusPill', () => {
  it('always carries its meaning in text, never colour alone', () => {
    const html = renderToStaticMarkup(<StatusPill tone="negative">Disputed</StatusPill>);
    expect(html).toContain('data-tone="negative"');
    expect(html).toContain('Disputed');
  });

  it('shows a dot for live by default and on request otherwise', () => {
    expect(renderToStaticMarkup(<StatusPill tone="live">Live</StatusPill>)).toContain('so-pill__dot');
    expect(renderToStaticMarkup(<StatusPill tone="neutral">Idle</StatusPill>)).not.toContain('so-pill__dot');
    expect(renderToStaticMarkup(<StatusPill tone="neutral" dot>Idle</StatusPill>)).toContain('so-pill__dot');
  });
});

describe('AppShell', () => {
  it('renders header, main and optional footer landmarks', () => {
    const html = renderToStaticMarkup(
      <AppShell brand={<span>Sideout</span>} footer={<span>foot</span>}>
        <p>content</p>
      </AppShell>,
    );
    expect(html).toContain('<header class="so-shell__header">');
    expect(html).toContain('<main class="so-shell__main"><p>content</p></main>');
    expect(html).toContain('<footer class="so-shell__footer">');
    expect(renderToStaticMarkup(<AppShell brand="B">x</AppShell>)).not.toContain('<footer');
  });
});

describe('primitives consume the token layer', () => {
  it('each button variant and pill tone is styled from tokens, not literals', async () => {
    const css = await readFile(COMPONENTS_CSS, 'utf8');
    expect(css).toMatch(/\[data-variant='primary'\][\s\S]*?--btn-bg: var\(--volt\)/);
    expect(css).toMatch(/\[data-variant='primary'\][\s\S]*?--btn-fg: var\(--on-volt\)/);
    expect(css).toMatch(/\[data-variant='danger'\][\s\S]*?var\(--fault\)/);
    expect(css).toMatch(/\[data-tone='live'\][\s\S]*?var\(--surf\)/);
    expect(css).toMatch(/\[data-tone='impact'\][\s\S]*?var\(--ember\)/);
    // Spec 6.1: no hard-coded colours outside tokens.css.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // Spec 6.4: 44px minimum target via the token, 2px volt focus ring.
    expect(css).toContain('min-height: var(--target-min)');
    expect(css).toMatch(/outline: var\(--focus-ring-width\) solid var\(--volt\)/);
  });
});
