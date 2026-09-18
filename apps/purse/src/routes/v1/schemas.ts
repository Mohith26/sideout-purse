import { z } from 'zod';
import { isId } from '@repo/ids';

import { RequestValidationError } from '../../http/errors';

/**
 * Zod on every body and path parameter (spec 4). Money arrives as a decimal string of minor
 * units, or as an integer that is exact in JSON; it leaves as a `bigint`. Ids are checked
 * for their prefix before any lookup so a wrong-shaped id is `invalid_request`, not a miss.
 */
const AMOUNT_SHAPE = /^(0|[1-9][0-9]*)$/;
const MAX_AMOUNT = 9_223_372_036_854_775_807n;

export const moneySchema = z
  .union([z.string().regex(AMOUNT_SHAPE, 'must be a decimal string of minor units'), z.number().int().nonnegative().safe()])
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_AMOUNT, 'exceeds the largest representable amount');

export const positiveMoneySchema = moneySchema.refine((value) => value > 0n, 'must be positive');

export const userIdSchema = z.string().refine((value) => isId(value, 'usr'), 'must be a usr_ id');
export const contestIdSchema = z.string().refine((value) => isId(value, 'cnt'), 'must be a cnt_ id');

export function param<S extends z.ZodType>(schema: S, name: string, value: string | undefined): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestValidationError(result.error, [name]);
  return result.data;
}
