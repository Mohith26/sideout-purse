import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AppShell, StatusPill } from '../src/index';

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
