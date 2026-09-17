import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AppShell } from '../src/index';

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
