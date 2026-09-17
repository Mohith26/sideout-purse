import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@repo/ids';

import { connect, type Database } from '../src/db/client';
import { charities } from '../src/db/schema';
import { env } from '../src/env';
import { homeSnapshot } from '../src/home/snapshot';

describe('home snapshot', () => {
  let database: Database;
  beforeAll(() => {
    database = connect(env().databaseUrl, { max: 1 });
  });
  afterAll(async () => {
    await database.db.delete(charities);
    await database.close();
  });

  it('reads an empty database as "no events yet"', async () => {
    expect(await homeSnapshot(database.db)).toEqual({ liveEvents: 0, upcomingEvents: 0, activeCharities: 0 });
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
      .values({ id: newId('sou'), slug: 'bad', name: 'Bad' })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toMatch(/charities_id_prefix/);
  });
});
