import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import { charities } from '../src/db/schema';
import { homeSnapshot } from '../src/home/snapshot';
import { testDatabase, truncateAll, type Database } from './helpers';

describe('home snapshot', () => {
  let database: Database;
  beforeAll(async () => {
    database = testDatabase();
    await truncateAll(database);
  });
  afterAll(async () => {
    await truncateAll(database);
    await database.close();
  });

  it('reads an empty database as zero beneficiaries', async () => {
    expect(await homeSnapshot(database.db)).toEqual({ activeCharities: 0 });
  });

  it('counts only active beneficiaries through a real query', async () => {
    await database.db.insert(charities).values([
      { id: newId('chr'), slug: 'surfrider', name: 'Surfrider Foundation' },
      { id: newId('chr'), slug: 'retired', name: 'Retired Charity', status: 'inactive' },
    ]);
    expect((await homeSnapshot(database.db)).activeCharities).toBe(1);
  });

  it('rejects a mis-prefixed id at the database level', async () => {
    const failure = await database.db
      .insert(charities)
      .values({ id: newId('tnt'), slug: 'bad', name: 'Bad' })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toMatch(/charities_id_prefix/);
  });
});
