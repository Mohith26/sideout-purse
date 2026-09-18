import { z } from 'zod';

import { themeSchema, MOUNTABLE_FLOWS, type EmbedError, type EmbedUserState, type FlowResult } from './embed';
import { API_ERROR_TYPES } from './errors';
import { ASSETS, RESTRICTION_KINDS, VERIFICATION_STATES } from './resources';

/**
 * The iframe message protocol (spec 4.8), shared by `@purse/sdk` (the parent page) and the
 * embed app (the frame). This file is the one definition: both sides validate every
 * message they receive against these schemas with `parseMessage`, after checking
 * `event.origin`, and drop anything that fails either check (rule 3). Every message
 * carries `v` from the first commit (this is version 1); a later version adds a schema
 * and a `v` literal rather than changing these.
 *
 * The handshake (rule 4):
 *
 *   1. The frame loads and posts `ready` to the parent origin it was given in its URL,
 *      once that origin is on its tenant's allowlist. `ready` is the one message with no
 *      nonce, because there is none yet.
 *   2. The parent mints a nonce and posts `hello` with it, the flow, the publishable key,
 *      the embed token (or none for `signin`), the theme and the flow's context.
 *   3. The frame redeems the token on the Purse origin and answers `hello_ack` with the
 *      nonce and the user state, or `error`.
 *
 * From then on every message in both directions carries the nonce, and a message with a
 * missing or different one is dropped and counted. Resizing (rule 6) is the frame
 * reporting its content height in `resize`, on load and whenever it changes, and the
 * parent asking for a fresh measurement with `resize:request`.
 */
export const PROTOCOL_VERSION = 1;

export const NONCE_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

const version = z.literal(PROTOCOL_VERSION);
const nonce = z.string().regex(NONCE_SHAPE);
const flow = z.enum(MOUNTABLE_FLOWS);
const idLike = z.string().min(1).max(128);
const instant = z.string().min(1).max(64);

const apiErrorSchema = z
  .object({
    type: z.enum(API_ERROR_TYPES),
    code: z.string().min(1).max(128),
    message: z.string().max(2000),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const verificationSchema = z
  .object({ state: z.enum(VERIFICATION_STATES), provider: z.string().nullable(), verifiedAt: instant.nullable(), reverifyAfter: instant.nullable() })
  .strict();

const restrictionSchema = z
  .object({ id: idLike, kind: z.enum(RESTRICTION_KINDS), reason: z.string().nullable().optional(), startsAt: instant, endsAt: instant.nullable() })
  .strict();

const walletBalanceSchema = z.object({ asset: z.enum(ASSETS), balance: z.string().regex(/^-?\d+$/), accountId: idLike.nullable() }).strict();

export const embedUserSchema = z
  .object({
    id: idLike,
    externalId: z.string().min(1).max(255),
    displayName: z.string().max(200).nullable(),
    verification: verificationSchema,
    restrictions: z.array(restrictionSchema).max(100),
    wallet: z.array(walletBalanceSchema).max(10),
  })
  .strict();

export const embedUserStateSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false), user: z.null() }).strict(),
  z.object({ authenticated: z.literal(true), user: embedUserSchema }).strict(),
]);

const flowResultSchema = z.discriminatedUnion('flow', [
  z.object({ flow: z.literal('signin'), userId: idLike }).strict(),
  z.object({ flow: z.literal('identity'), userId: idLike, verification: verificationSchema }).strict(),
  z.object({ flow: z.literal('wallet'), userId: idLike }).strict(),
  z.object({ flow: z.literal('entry'), userId: idLike, contestId: idLike, participantId: idLike, journalEntryId: idLike }).strict(),
  z.object({ flow: z.literal('rewards'), userId: idLike }).strict(),
]);

/** What a flow needs beyond the user the token names: the contest an entry confirms. */
export const flowContextSchema = z.object({ contestId: idLike.optional() }).strict();
export type FlowContext = z.infer<typeof flowContextSchema>;

// ---- Parent -> embed -----------------------------------------------------------------

export const helloSchema = z
  .object({
    v: version,
    type: z.literal('hello'),
    nonce,
    flow,
    publishableKey: z.string().regex(/^pk_(sandbox|live)_[A-Za-z0-9]{32}$/),
    embedToken: z.string().regex(/^embt_[A-Za-z0-9_-]{43}$/).nullable(),
    theme: themeSchema.nullable(),
    context: flowContextSchema,
  })
  .strict();

export const resizeRequestSchema = z.object({ v: version, type: z.literal('resize:request'), nonce }).strict();

export const stateRequestSchema = z.object({ v: version, type: z.literal('state:request'), nonce }).strict();

export const toEmbedSchema = z.discriminatedUnion('type', [helloSchema, resizeRequestSchema, stateRequestSchema]);

export type HelloMessage = z.infer<typeof helloSchema>;
export type ResizeRequestMessage = z.infer<typeof resizeRequestSchema>;
export type StateRequestMessage = z.infer<typeof stateRequestSchema>;
export type ToEmbedMessage = z.infer<typeof toEmbedSchema>;

// ---- Embed -> parent -----------------------------------------------------------------

export const readySchema = z.object({ v: version, type: z.literal('ready') }).strict();

export const helloAckSchema = z.object({ v: version, type: z.literal('hello_ack'), nonce, flow, state: embedUserStateSchema }).strict();

export const resizeSchema = z.object({ v: version, type: z.literal('resize'), nonce, height: z.number().int().min(0).max(20_000) }).strict();

export const flowCompleteSchema = z.object({ v: version, type: z.literal('flow:complete'), nonce, result: flowResultSchema }).strict();

export const errorMessageSchema = z.object({ v: version, type: z.literal('error'), nonce, error: apiErrorSchema, fatal: z.boolean() }).strict();

export const stateSchema = z.object({ v: version, type: z.literal('state'), nonce, state: embedUserStateSchema }).strict();

export const toParentSchema = z.discriminatedUnion('type', [readySchema, helloAckSchema, resizeSchema, flowCompleteSchema, errorMessageSchema, stateSchema]);

export type ReadyMessage = z.infer<typeof readySchema>;
export type HelloAckMessage = Omit<z.infer<typeof helloAckSchema>, 'state'> & { state: EmbedUserState };
export type ResizeMessage = z.infer<typeof resizeSchema>;
export type FlowCompleteMessage = Omit<z.infer<typeof flowCompleteSchema>, 'result'> & { result: FlowResult };
export type ErrorMessage = Omit<z.infer<typeof errorMessageSchema>, 'error'> & { error: EmbedError };
export type StateMessage = Omit<z.infer<typeof stateSchema>, 'state'> & { state: EmbedUserState };
export type ToParentMessage = ReadyMessage | HelloAckMessage | ResizeMessage | FlowCompleteMessage | ErrorMessage | StateMessage;

export type ProtocolMessage = ToEmbedMessage | ToParentMessage;

// ---- Parsing -------------------------------------------------------------------------

/**
 * Why a message was dropped. Both sides count drops by reason (spec 4.8 rule 3, "dropped
 * silently and counted"); `origin` and `nonce` are the receivers' own checks, listed here
 * so one counter covers everything.
 */
export const DROP_REASONS = ['origin', 'not_an_object', 'unsupported_version', 'unknown_type', 'invalid_shape', 'nonce', 'unexpected'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type ParsedMessage<M> = { ok: true; message: M } | { ok: false; reason: DropReason };

const TO_EMBED_TYPES: ReadonlySet<string> = new Set(toEmbedSchema.options.map((option) => option.shape.type.value));
const TO_PARENT_TYPES: ReadonlySet<string> = new Set(toParentSchema.options.map((option) => option.shape.type.value));

function classify(data: unknown, known: ReadonlySet<string>): DropReason | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'not_an_object';
  const record = data as Record<string, unknown>;
  if (record['v'] !== PROTOCOL_VERSION) return 'unsupported_version';
  if (typeof record['type'] !== 'string' || !known.has(record['type'])) return 'unknown_type';
  return undefined;
}

/** Validate a message the embed received from its parent. */
export function parseToEmbedMessage(data: unknown): ParsedMessage<ToEmbedMessage> {
  const reason = classify(data, TO_EMBED_TYPES);
  if (reason !== undefined) return { ok: false, reason };
  const result = toEmbedSchema.safeParse(data);
  return result.success ? { ok: true, message: result.data } : { ok: false, reason: 'invalid_shape' };
}

/** Validate a message the parent received from the embed. */
export function parseToParentMessage(data: unknown): ParsedMessage<ToParentMessage> {
  const reason = classify(data, TO_PARENT_TYPES);
  if (reason !== undefined) return { ok: false, reason };
  const result = toParentSchema.safeParse(data);
  return result.success ? { ok: true, message: result.data as ToParentMessage } : { ok: false, reason: 'invalid_shape' };
}

/** One entry point for either side: `direction` names who is receiving. */
export function parseMessage(direction: 'to-embed', data: unknown): ParsedMessage<ToEmbedMessage>;
export function parseMessage(direction: 'to-parent', data: unknown): ParsedMessage<ToParentMessage>;
export function parseMessage(direction: 'to-embed' | 'to-parent', data: unknown): ParsedMessage<ToEmbedMessage> | ParsedMessage<ToParentMessage> {
  return direction === 'to-embed' ? parseToEmbedMessage(data) : parseToParentMessage(data);
}

/** A tally of drops by reason, the counter both receivers expose for tests and for a console. */
export type DropCounts = Record<DropReason, number>;

export function emptyDropCounts(): DropCounts {
  return { origin: 0, not_an_object: 0, unsupported_version: 0, unknown_type: 0, invalid_shape: 0, nonce: 0, unexpected: 0 };
}
