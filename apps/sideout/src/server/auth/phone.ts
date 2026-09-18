import { z } from 'zod';

import { PHONE_E164_PATTERN } from '../../db/schema';

/**
 * Phone numbers are E.164 everywhere: a leading `+`, then 7 to 15 digits. Spaces, dashes
 * and parentheses are stripped before validation so `+1 (555) 010-0001` is accepted and
 * stored as `+15550100001`.
 */
export const phoneE164Schema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(new RegExp(PHONE_E164_PATTERN), 'must be an E.164 phone number, e.g. +15550100001'));
