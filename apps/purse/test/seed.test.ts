import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import { connect, type Database } from '../src/db/client';
import { tenants } from '../src/db/schema';
import { SIDEOUT_TENANT_ID, SIDEOUT_TENANT_NAME, seedSideoutTenant } from '../src/db/seed';
import { env } from '../src/env';

describe('db:seed', () => {
  let database: Database;
  beforeAll(() => {
    database = connect(env().databaseUrl, { max: 1 });
  });
  beforeEach(async () => {
    await database.db.delete(tenants);
  });
  afterAll(async () => {
    await database.db.delete(tenants);
    await database.close();
  });

  it('creates the Sideout tenant with its stable id on an empty database', async () => {
    const result = await seedSideoutTenant(database.db);
    expect(result.created).toBe(true);
    expect(result.tenant).toMatchObject({ id: SIDEOUT_TENANT_ID, name: SIDEOUT_TENANT_NAME, status: 'active' });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('is idempotent: a second run changes nothing and reports the row already present', async () => {
    const first = await seedSideoutTenant(database.db);
    const second = await seedSideoutTenant(database.db);
    expect(second).toEqual({ tenant: first.tenant, created: false });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });

  it('keys on the name, so an existing Sideout tenant is kept as is rather than duplicated', async () => {
    const existingId = newId('tnt');
    await database.db.insert(tenants).values({ id: existingId, name: SIDEOUT_TENANT_NAME, status: 'suspended' });

    const result = await seedSideoutTenant(database.db);
    expect(result.created).toBe(false);
    expect(result.tenant).toMatchObject({ id: existingId, name: SIDEOUT_TENANT_NAME, status: 'suspended' });
    expect(await database.db.select().from(tenants)).toHaveLength(1);
  });
});
