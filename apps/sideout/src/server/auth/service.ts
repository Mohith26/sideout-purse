import { and, desc, eq, isNull } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { Db } from '../../db/client';
import { authCodes, users, type User } from '../../db/schema';
import { mintPurseExternalId } from '../actor';
import { writeAudit } from '../audit';
import { failure } from '../http/errors';
import { CODE_MAX_ATTEMPTS, CODE_TTL_SECONDS, codeMatches, generateCode, hashCode } from './codes';
import type { RateLimiter } from './rate-limit';
import { SmsUnavailableError, type SmsSender } from './sms';

/**
 * Phone-number sign-in. `requestCode` issues a one-time code and sends it through the
 * `SmsSender` seam; `verifyCode` consumes it and returns the user, creating the local
 * account (with a freshly minted Purse external id) on first sign-in.
 */

export type AuthLimiters = {
  perAddress: RateLimiter;
  perPhone: RateLimiter;
  global: RateLimiter;
};

export type AuthServiceDeps = {
  db: Db;
  sms: SmsSender;
  sessionSecret: string;
  limiters: AuthLimiters;
  /** Outside production the issued code is echoed in the response for tests and local use. */
  echoCodes: boolean;
};

export type RequestCodeInput = { phoneE164: string; address: string; now: Date };
export type RequestCodeResult = { expiresAt: Date; code?: string };

export type VerifyCodeInput = { phoneE164: string; code: string; displayName?: string | undefined; now: Date };
export type VerifyCodeResult = { user: User; created: boolean };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function displayNameFor(phoneE164: string): string {
  return `Player ${phoneE164.slice(-4)}`;
}

export function createAuthService(deps: AuthServiceDeps) {
  return {
    async requestCode(input: RequestCodeInput): Promise<RequestCodeResult> {
      for (const [name, limiter, key] of [
        ['global', deps.limiters.global, 'global'],
        ['address', deps.limiters.perAddress, input.address],
        ['phone', deps.limiters.perPhone, input.phoneE164],
      ] as const) {
        const verdict = limiter.hit(key, input.now);
        if (!verdict.allowed) {
          throw failure.rateLimited('too_many_requests', 'Too many sign-in codes requested; try again shortly.', {
            scope: name,
            retryAfterSeconds: verdict.retryAfterSeconds,
          });
        }
      }

      if (deps.sms.name === 'unavailable') {
        throw failure.internal('sms_unavailable', 'Sign-in by SMS is not available right now.').withStatus(503);
      }

      const code = generateCode();
      const expiresAt = new Date(input.now.getTime() + CODE_TTL_SECONDS * 1000);
      await deps.db.transaction(async (tx) => {
        await tx.insert(authCodes).values({
          id: newId('otp'),
          phoneE164: input.phoneE164,
          codeHash: hashCode(code, input.phoneE164, deps.sessionSecret),
          expiresAt,
          createdAt: input.now,
        });
        try {
          await deps.sms.send({ to: input.phoneE164, body: `Your Sideout sign-in code is ${code}. It expires in 10 minutes.` });
        } catch (error) {
          if (error instanceof SmsUnavailableError) {
            throw failure.internal('sms_unavailable', 'Sign-in by SMS is not available right now.').withStatus(503);
          }
          throw error;
        }
      });

      return deps.echoCodes ? { expiresAt, code } : { expiresAt };
    },

    async verifyCode(input: VerifyCodeInput): Promise<VerifyCodeResult> {
      const outcome = await deps.db.transaction(async (tx) => {
        const [latest] = await tx
          .select()
          .from(authCodes)
          .where(and(eq(authCodes.phoneE164, input.phoneE164), isNull(authCodes.consumedAt)))
          .orderBy(desc(authCodes.createdAt))
          .limit(1)
          .for('update');
        if (latest === undefined) return { ok: false as const, code: 'code_invalid' as const };
        if (latest.expiresAt.getTime() <= input.now.getTime()) return { ok: false as const, code: 'code_expired' as const };
        if (latest.attempts >= CODE_MAX_ATTEMPTS) return { ok: false as const, code: 'code_locked' as const };

        const matched = codeMatches(latest.codeHash, input.code, input.phoneE164, deps.sessionSecret);
        await tx
          .update(authCodes)
          .set({ attempts: latest.attempts + 1, ...(matched ? { consumedAt: input.now } : {}) })
          .where(eq(authCodes.id, latest.id));
        if (!matched) return { ok: false as const, code: 'code_invalid' as const };

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

        const [created] = await tx
          .insert(users)
          .values({
            id: newId('sou'),
            purseExternalId: mintPurseExternalId('user'),
            displayName: nonEmpty(input.displayName) ?? displayNameFor(input.phoneE164),
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
