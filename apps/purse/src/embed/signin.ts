import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { newId, type Id } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { embedSigninCodes, users, type User } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import type { ProcessKeys } from '../secrets';
import { EmbedError } from './errors';
import type { SmsSender } from './sms';

/**
 * Phone plus one-time code sign-in for the embed's `signin` flow (spec 4.8), the same
 * shape as Sideout's own sign-in: six digits from `crypto.randomInt`, ten minutes, five
 * guesses, stored only as an HMAC under the process's `signin-code` key and bound to the
 * phone it was issued for. The phone must belong to a user of the tenant the publishable
 * key names; whether it does is never revealed by `startSignin` (a code is "sent" either
 * way and only `verifySignin` refuses), so a public key cannot be used to enumerate a
 * partner's phone numbers. At most `CODES_PER_WINDOW` codes are issued per phone per ten
 * minutes.
 */
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODES_PER_WINDOW = 5;
export const CODE_WINDOW_MS = 10 * 60_000;

export const PHONE_E164 = /^\+[1-9][0-9]{6,14}$/;

export function generateCode(random: (min: number, max: number) => number = randomInt): string {
  return String(random(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

export function hashCode(keys: ProcessKeys, tenantId: Id<'tnt'>, phoneE164: string, code: string): string {
  return createHmac('sha256', keys['signin-code']).update(`${tenantId}:${phoneE164}:${code}`).digest('hex');
}

function codeMatches(stored: string, candidate: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function userByPhone(db: DbOrTx, tenantId: Id<'tnt'>, phoneE164: string): Promise<User | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.phoneE164, phoneE164)))
    .orderBy(desc(users.updatedAt))
    .limit(1);
  return row;
}

export type StartSigninInput = {
  tenantId: Id<'tnt'>;
  phoneE164: string;
  sms: SmsSender;
  now?: Date;
  requestId?: string;
};

export type StartedSignin = {
  sent: true;
  expiresAt: string;
  /** The code itself, only from the `log` sender outside production (spec: the dev implementation echoes). */
  devCode: string | null;
};

export async function startSignin(db: DbOrTx, keys: ProcessKeys, input: StartSigninInput): Promise<StartedSignin> {
  if (!PHONE_E164.test(input.phoneE164)) throw new EmbedError('invalid_input', 'phoneE164 must be E.164, +14155550123', { field: 'phoneE164' });
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);

  const [recent] = await db
    .select({ n: count() })
    .from(embedSigninCodes)
    .where(and(eq(embedSigninCodes.tenantId, input.tenantId), eq(embedSigninCodes.phoneE164, input.phoneE164), gt(embedSigninCodes.createdAt, new Date(now.getTime() - CODE_WINDOW_MS))));
  if ((recent?.n ?? 0) >= CODES_PER_WINDOW) {
    throw new EmbedError('too_many_codes', `At most ${CODES_PER_WINDOW} codes may be requested per ten minutes`, { retryAfterSeconds: Math.ceil(CODE_WINDOW_MS / 1000) });
  }

  const user = await userByPhone(db, input.tenantId, input.phoneE164);
  // No user with this phone: answer as if a code went out, and issue none.
  if (user === undefined) return { sent: true, expiresAt: expiresAt.toISOString(), devCode: null };

  const code = generateCode();
  await db.insert(embedSigninCodes).values({ id: newId('sic'), tenantId: input.tenantId, phoneE164: input.phoneE164, codeHash: hashCode(keys, input.tenantId, input.phoneE164, code), expiresAt, createdAt: now });
  await input.sms.send({ to: input.phoneE164, body: `Your Purse sign-in code is ${code}. It expires in 10 minutes.` });
  return { sent: true, expiresAt: expiresAt.toISOString(), devCode: input.sms.echoesCode ? code : null };
}

export type VerifySigninInput = {
  tenantId: Id<'tnt'>;
  phoneE164: string;
  code: string;
  now?: Date;
  actor?: Actor;
  requestId?: string;
};

/**
 * Check a code against the newest unconsumed one for the phone. A wrong guess counts
 * against that code; the fifth exhausts it. The refusals are told apart in `code` for the
 * UI, but none says whether the phone belongs to anyone.
 */
export async function verifySignin(db: DbOrTx, keys: ProcessKeys, input: VerifySigninInput): Promise<User> {
  if (!PHONE_E164.test(input.phoneE164)) throw new EmbedError('invalid_input', 'phoneE164 must be E.164, +14155550123', { field: 'phoneE164' });
  if (!/^\d{6}$/.test(input.code)) throw new EmbedError('invalid_code', 'The code is not valid');
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [live] = await tx
      .select()
      .from(embedSigninCodes)
      .where(and(eq(embedSigninCodes.tenantId, input.tenantId), eq(embedSigninCodes.phoneE164, input.phoneE164), isNull(embedSigninCodes.consumedAt)))
      .orderBy(desc(embedSigninCodes.createdAt))
      .limit(1)
      .for('update');
    if (live === undefined) throw new EmbedError('invalid_code', 'The code is not valid');
    if (live.expiresAt.getTime() <= now.getTime()) throw new EmbedError('code_expired', 'The code has expired; request a new one');
    if (live.attempts >= CODE_MAX_ATTEMPTS) throw new EmbedError('too_many_attempts', 'Too many wrong guesses; request a new code');
    if (!codeMatches(live.codeHash, hashCode(keys, input.tenantId, input.phoneE164, input.code))) {
      await tx.update(embedSigninCodes).set({ attempts: live.attempts + 1 }).where(eq(embedSigninCodes.id, live.id));
      throw new EmbedError('invalid_code', 'The code is not valid', { attemptsLeft: CODE_MAX_ATTEMPTS - live.attempts - 1 });
    }
    await tx.update(embedSigninCodes).set({ consumedAt: sql`clock_timestamp()` }).where(eq(embedSigninCodes.id, live.id));
    const user = await userByPhone(tx, input.tenantId, input.phoneE164);
    if (user === undefined) throw new EmbedError('invalid_code', 'The code is not valid');
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'embed.signed_in',
      subject: user.id,
      before: null,
      after: { codeId: live.id },
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return user;
  });
}
