import { randomInt } from 'node:crypto';

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';
import { newId } from '@repo/ids';

import type { DbOrTx } from '../db/client';
import { operators, type Operator, type OperatorRole } from '../db/schema';
import { recordAudit, SYSTEM_ACTOR, type Actor } from '../ledger/audit';
import { OperatorError } from './errors';

/**
 * Operator accounts (spec 4.10). An operator signs in to the console with an email and a
 * password; only an argon2id hash is stored (OWASP's 19 MiB / 2 iterations / 1 lane, the
 * parameters API keys use), and a password is never logged, audited or returned. Accounts
 * are created by the seed (the first admin) and by the owner role; the runtime holds
 * SELECT and the one UPDATE a password change needs (`drizzle/0014_operator_guards.sql`).
 */
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 512;
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Unambiguous characters (no 0/O, 1/l/I) so a generated password survives being read aloud. */
const GENERATED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const GENERATED_PASSWORD_LENGTH = 24;

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(normalized) || normalized.length > 254) {
    throw new OperatorError('invalid_input', 'email must be a valid address', { field: 'email' });
  }
  return normalized;
}

export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new OperatorError('invalid_input', `password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`, { field: 'password' });
  }
}

/** A random password for a seeded account: 24 characters from an unambiguous alphabet, about 140 bits. */
export function generatePassword(): string {
  let out = '';
  for (let i = 0; i < GENERATED_PASSWORD_LENGTH; i += 1) out += GENERATED_ALPHABET[randomInt(GENERATED_ALPHABET.length)];
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2);
}

export async function verifyPassword(operator: Pick<Operator, 'passwordHash'>, password: string): Promise<boolean> {
  return argon2Verify(operator.passwordHash, password);
}

/** What an audit row or the console may show of an operator: never the hash. */
export function publicFields(operator: Operator): Record<string, unknown> {
  return { id: operator.id, email: operator.email, role: operator.role, disabledAt: operator.disabledAt };
}

export type CreateOperatorInput = {
  email: string;
  password: string;
  role: OperatorRole;
  actor?: Actor;
  requestId?: string;
};

export async function createOperator(db: DbOrTx, input: CreateOperatorInput): Promise<Operator> {
  const email = normalizeEmail(input.email);
  validatePassword(input.password);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: operators.id }).from(operators).where(eq(operators.email, email));
    if (existing !== undefined) throw new OperatorError('email_taken', `An operator with email ${email} already exists`, { email });
    const [row] = await tx.insert(operators).values({ id: newId('opr'), email, passwordHash, role: input.role }).returning();
    if (row === undefined) throw new Error('operators insert returned no row');
    await recordAudit(tx, {
      tenantId: null,
      actor: input.actor ?? SYSTEM_ACTOR,
      action: 'operator.created',
      subject: row.id,
      before: null,
      after: publicFields(row),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return row;
  });
}

export async function findOperatorByEmail(db: DbOrTx, email: string): Promise<Operator | undefined> {
  const [row] = await db.select().from(operators).where(eq(operators.email, email.trim().toLowerCase()));
  return row;
}

export async function getOperator(db: DbOrTx, operatorId: string): Promise<Operator> {
  const [row] = await db.select().from(operators).where(eq(operators.id, operatorId));
  if (row === undefined) throw new OperatorError('operator_not_found', `No operator ${operatorId}`, { operatorId });
  return row;
}

export async function listOperators(db: DbOrTx): Promise<Operator[]> {
  return db.select().from(operators).orderBy(operators.createdAt, operators.id);
}

export type SetPasswordInput = {
  operatorId: string;
  /** Required when the operator changes their own password; the seed's rotation passes none. */
  currentPassword?: string;
  newPassword: string;
  actor: Actor;
  requestId?: string;
};

/** Replace the hash; the caller revokes the operator's other sessions. */
export async function setPassword(db: DbOrTx, input: SetPasswordInput): Promise<Operator> {
  validatePassword(input.newPassword);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(operators).where(eq(operators.id, input.operatorId)).for('update');
    if (before === undefined) throw new OperatorError('operator_not_found', `No operator ${input.operatorId}`, { operatorId: input.operatorId });
    if (input.currentPassword !== undefined && !(await verifyPassword(before, input.currentPassword))) {
      throw new OperatorError('invalid_credentials', 'The current password is wrong');
    }
    const passwordHash = await hashPassword(input.newPassword);
    const [after] = await tx.update(operators).set({ passwordHash, updatedAt: sql`now()` }).where(eq(operators.id, before.id)).returning();
    if (after === undefined) throw new Error(`operators update of ${before.id} returned no row`);
    await recordAudit(tx, {
      tenantId: null,
      actor: input.actor,
      action: 'operator.password_changed',
      subject: before.id,
      before: publicFields(before),
      after: publicFields(after),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    return after;
  });
}

/** The audit actor a signed-in operator acts as everywhere in the console. */
export function operatorActor(operator: Pick<Operator, 'id'>): Actor {
  return { kind: 'operator', ref: operator.id };
}
