import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../../db/client';
import { authCodes, users, type User } from '../../db/schema';
import { mintPurseExternalId } from '../actor';
import { writeAudit } from '../audit';
import { failure } from '../http/errors';
import { CODE_MAX_ATTEMPTS, CODE_TTL_SECONDS, codeMatches, generateCode, hashCode } from './codes';
import { defaultDisplayName } from './display-name';
import type { RateLimiter } from './rate-limit';
import { SmsUnavailableError, type SmsSender } from './sms';

/**
 * Phone-number sign-in. `requestCode` issues a one-time code, sends it through the
 * `SmsSender` seam and returns the code's id; `verifyCode` takes that id and the code,
 * consumes it and returns the user, creating the local account (with a freshly minted
 * Purse external id) on first sign-in. Requesting a code is unauthenticated, so the codes
 * already out for a number are never touched by a new request: every unexpired, unconsumed
 * code verifies, guesses count against the one code they name, and a successful one
 * consumes every code out for the number.
 */

export type AuthLimiters = {
  /** Code requests per client address. */
  perAddress: RateLimiter;
  /** Code requests per phone number; also how many codes can be live for it at once. */
  perPhone: RateLimiter;
  /** Code requests for the whole instance: the SMS budget. */
  global: RateLimiter;
  /** Verify attempts per client address. */
  verifyPerAddress: RateLimiter;
};

export type AuthServiceDeps = {
  db: Db;
  sms: SmsSender;
  sessionSecret: string;
  limiters: AuthLimiters;
  /** Outside production the issued code is echoed in the response for tests and local use, with the contract spelled out. */
  echoCodes: boolean;
};

/** What the non-production echo says about the contract the sign-in screen must keep. */
export const ECHO_HINT = 'Verify with this codeId and the code from the most recent message; keep the latest codeId when a code is requested again.';

export type RequestCodeInput = { phoneE164: string; address: string; now: Date };
export type RequestCodeResult = { codeId: string; expiresAt: Date; code?: string; hint?: string };

export type VerifyCodeInput = { phoneE164: string; codeId: string; code: string; address: string; displayName?: string | undefined; now: Date };
export type VerifyCodeResult = { user: User; created: boolean };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function createAuthService(deps: AuthServiceDeps) {
  return {
    async requestCode(input: RequestCodeInput): Promise<RequestCodeResult> {
      // Every cap is consulted before any is charged, so a request one cap refuses never
      // spends another (a refused address cannot eat the number's window or the SMS budget).
      const caps = [
        ['phone', deps.limiters.perPhone, input.phoneE164],
        ['address', deps.limiters.perAddress, input.address],
        ['global', deps.limiters.global, 'global'],
      ] as const;
      for (const [name, limiter, key] of caps) {
        const verdict = limiter.check(key, input.now);
        if (!verdict.allowed) {
          throw failure.rateLimited('too_many_requests', 'Too many sign-in codes requested; try again shortly.', {
            scope: name,
            retryAfterSeconds: verdict.retryAfterSeconds,
          });
        }
      }
      for (const [, limiter, key] of caps) limiter.hit(key, input.now);

      if (deps.sms.name === 'unavailable') {
        throw failure.internal('sms_unavailable', 'Sign-in by SMS is not available right now.').withStatus(503);
      }

      const code = generateCode();
      const expiresAt = new Date(input.now.getTime() + CODE_TTL_SECONDS * 1000);
      const id = newId('otp');
      await deps.db.insert(authCodes).values({
        id,
        phoneE164: input.phoneE164,
        codeHash: hashCode(code, input.phoneE164, deps.sessionSecret),
        expiresAt,
        createdAt: input.now,
      });
      // The provider's network call happens with no database connection held; a code that
      // could not be delivered is consumed at once so it can never be guessed.
      try {
        await deps.sms.send({ to: input.phoneE164, body: `Your Sideout sign-in code is ${code}. It expires in 10 minutes.` });
      } catch (error) {
        await deps.db.update(authCodes).set({ consumedAt: input.now }).where(eq(authCodes.id, id));
        if (error instanceof SmsUnavailableError) {
          throw failure.internal('sms_unavailable', 'Sign-in by SMS is not available right now.').withStatus(503);
        }
        throw error;
      }

      return deps.echoCodes ? { codeId: id, expiresAt, code, hint: ECHO_HINT } : { codeId: id, expiresAt };
    },

    async verifyCode(input: VerifyCodeInput): Promise<VerifyCodeResult> {
      const verdict = deps.limiters.verifyPerAddress.hit(input.address, input.now);
      if (!verdict.allowed) {
        throw failure.rateLimited('too_many_requests', 'Too many sign-in attempts; try again shortly.', {
          scope: 'address',
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
      }

      const outcome = await deps.db.transaction(async (tx) => {
        const [issued] = await tx
          .select()
          .from(authCodes)
          .where(and(eq(authCodes.id, input.codeId), eq(authCodes.phoneE164, input.phoneE164)))
          .for('update');
        if (issued?.consumedAt !== null) return { ok: false as const, code: 'code_invalid' as const };
        if (issued.expiresAt.getTime() <= input.now.getTime()) return { ok: false as const, code: 'code_expired' as const };
        if (issued.attempts >= CODE_MAX_ATTEMPTS) return { ok: false as const, code: 'code_locked' as const };

        if (!codeMatches(issued.codeHash, input.code, input.phoneE164, deps.sessionSecret)) {
          await tx
            .update(authCodes)
            .set({ attempts: sql`${authCodes.attempts} + 1` })
            .where(eq(authCodes.id, issued.id));
          return { ok: false as const, code: 'code_invalid' as const };
        }
        await tx
          .update(authCodes)
          .set({ consumedAt: input.now })
          .where(and(eq(authCodes.phoneE164, input.phoneE164), isNull(authCodes.consumedAt), gt(authCodes.expiresAt, input.now)));

        const [existing] = await tx.select().from(users).where(eq(users.phoneE164, input.phoneE164)).limit(1);
        if (existing !== undefined) {
          await writeAudit(tx, {
            actor: { kind: existing.role, userId: existing.id },
            action: 'user.signed_in',
            subjectType: 'user',
            subjectId: existing.id,
            detail: {},
            at: input.now,
          });
          return { ok: true as const, user: existing, created: false };
        }

        const id = newId('sou');
        const [created] = await tx
          .insert(users)
          .values({
            id,
            purseExternalId: mintPurseExternalId('user'),
            displayName: nonEmpty(input.displayName) ?? defaultDisplayName(id),
            phoneE164: input.phoneE164,
            role: 'player',
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning();
        if (created === undefined) throw new Error('auth: user insert returned no row');
        await writeAudit(tx, {
          actor: { kind: 'player', userId: created.id },
          action: 'user.created',
          subjectType: 'user',
          subjectId: created.id,
          detail: { via: 'phone_code' },
          at: input.now,
        });
        return { ok: true as const, user: created, created: true };
      });

      if (!outcome.ok) {
        const messages = {
          code_invalid: 'That code is not right.',
          code_expired: 'That code has expired; request a new one.',
          code_locked: 'Too many wrong guesses; request a new code.',
        } as const;
        throw failure.authentication(outcome.code, messages[outcome.code]);
      }
      return { user: outcome.user, created: outcome.created };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
