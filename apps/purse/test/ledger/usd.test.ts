import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import type { Database } from '../../src/db/client';
import { asset } from '../../src/db/schema';
import { connectMigrator, connectRuntime } from '../helpers';
import { createTenant, wipeLedger } from './fixtures';

/**
 * Spec 4.2.6 and acceptance criterion 10: the compliance boundary made executable. No
 * Purse account exists with asset `USD`, and none can: the asset enum has no such value,
 * in the schema, in the migration history, or in the live database.
 */
describe('no USD in Purse', () => {
  let migrator: Database;
  let runtime: Database;
  beforeAll(() => {
    migrator = connectMigrator();
    runtime = connectRuntime();
  });
  afterAll(async () => {
    await wipeLedger(migrator);
    await migrator.close();
    await runtime.close();
  });

  it('no account row carries USD, and the live enum cannot express it', async () => {
    const rows = await runtime.db.execute<{ n: string }>(sql`select count(*)::text as n from accounts where asset::text = 'USD'`);
    expect(rows[0]?.n).toBe('0');

    const labels = await runtime.db.execute<{ label: string }>(
      sql`select enumlabel as label from pg_enum join pg_type on pg_type.oid = enumtypid where typname = 'asset' order by enumsortorder`,
    );
    expect(labels.map((row) => row.label)).toEqual(['POINTS', 'CREDIT']);
    expect(asset.enumValues).toEqual(['POINTS', 'CREDIT']);
  });

  it('inserting a USD account fails at the database, even as the owner', async () => {
    const tenantId = await createTenant(migrator.db);
    const failure = await migrator.sql`
      insert into accounts (id, tenant_id, kind, owner_ref, asset, normal_side)
      values (${newId('acct')}, ${tenantId}, 'promo_liability', null, 'USD', 'credit')
    `.then(() => undefined, (error: unknown) => String(error));
    expect(failure).toMatch(/invalid input value for enum asset: "USD"/);
  });

  it('the schema source and every migration name only POINTS and CREDIT as assets', async () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const schema = await readFile(path.join(root, 'src/db/schema.ts'), 'utf8');
    expect(schema).toMatch(/pgEnum\('asset', \['POINTS', 'CREDIT'\]\)/);
    const migration = await readFile(path.join(root, 'drizzle/0001_ledger.sql'), 'utf8');
    expect(migration).toContain(`CREATE TYPE "public"."asset" AS ENUM('POINTS', 'CREDIT');`);
    expect(migration).not.toMatch(/USD/);
  });
});
