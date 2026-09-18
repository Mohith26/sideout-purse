import type { Db } from '../db/client';

/** A drizzle database or the transaction handle it hands to a `transaction` callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
