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

describe('console primitives', () => {
  it('renders a dense table with declared columns, keyed rows and an explicit empty state', async () => {
    const { DataTable, Money, formatMoney, Chip, Notice, KeyValue } = await import('../src/index');
    type Row = { id: string; amount: string };
    const columns = [
      { key: 'id', header: 'Id', render: (row: Row) => row.id },
      { key: 'amount', header: 'Amount', numeric: true, render: (row: Row) => <Money amount={row.amount} asset="POINTS" /> },
    ];
    const filled = renderToStaticMarkup(<DataTable columns={columns} rows={[{ id: 'a', amount: '-1234567' }]} rowKey={(row) => row.id} />);
    expect(filled).toContain('<th scope="col" class="so-num">Amount</th>');
    expect(filled).toContain('−1,234,567');
    const empty = renderToStaticMarkup(<DataTable columns={columns} rows={[]} rowKey={(row) => row.id} empty="No rows" />);
    expect(empty).toContain('class="so-table__empty">No rows');
    expect(formatMoney(1000n)).toBe('1,000');
    expect(formatMoney('0')).toBe('0');
    expect(renderToStaticMarkup(<Chip tone="fault">failed</Chip>)).toBe('<span class="so-chip so-chip--fault">failed</span>');
    expect(renderToStaticMarkup(<Notice tone="error" title="Nope">why</Notice>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<KeyValue items={[{ key: 'State', value: 'open' }]} />)).toContain('<dt>State</dt><dd>open</dd>');
  });
});
