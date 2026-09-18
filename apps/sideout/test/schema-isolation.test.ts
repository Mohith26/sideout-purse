import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema';

/**
 * Acceptance criterion 21, checked against the typed model rather than the source text:
 * no Sideout table carries contest value, and the donations table references nothing
 * Purse-shaped. The import boundary itself is proven by the ESLint rule the root
 * `test/boundary.test.ts` runs against fixtures.
 */
const exported: Record<string, unknown> = schema;
const tables = Object.values(exported).filter((value): value is PgTable => is(value, PgTable));

describe('Sideout never shares a table with contest value', () => {
  it('exports the domain tables', () => {
    expect(tables.map(getTableName).sort()).toEqual(
      ['audit_log', 'auth_codes', 'charities', 'donation_provider_events', 'donations', 'matches', 'pool_teams', 'pools', 'sets', 'sponsors', 'team_members', 'teams', 'tournaments', 'users'].sort(),
    );
  });

  it('no column in any table names a POINTS or CREDIT asset, a balance, escrow, a payout or a wallet', () => {
    const offenders = tables.flatMap((table) =>
      Object.values(getTableColumns(table))
        .map((column) => column.name)
        .filter((name) => /asset|points_balance|credit|escrow|payout|wallet/.test(name))
        .map((name) => `${getTableName(table)}.${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('donations carry a real currency and reference no Purse object, by column or by foreign key', () => {
    const columns = Object.values(getTableColumns(schema.donations)).map((column) => column.name);
    expect(columns).toContain('currency');
    expect(columns.filter((name) => /purse/i.test(name))).toEqual([]);
    const referenced = getTableConfig(schema.donations).foreignKeys.map((fk) => getTableName(fk.reference().foreignTable));
    expect(referenced.sort()).toEqual(['teams', 'tournaments', 'users']);
  });
});
