import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, REQUEST_ID_HEADER, RETRY_AFTER_HEADER, isIdempotencyKey, type ContestKind, type EmbedFlow, type PrizeStructure, type WebhookEventType } from '@purse/types';
import type { z } from 'zod';

import { PurseApiError, PurseResponseError, PurseUnreachableError } from './errors';
import { redact, redactString } from './redact';
import {
  contestSchema,
  creditSchema,
  embedTokenSchema,
  entrySchema,
  errorEnvelopeSchema,
  previewSchema,
  resultsSchema,
  scoresSchema,
  settlementSchema,
  userSchema,
  voidSchema,
  walletSchema,
  webhookEndpointSchema,
} from './schemas';

/**
 * The one typed client over Purse's v1 API (spec 4.7), server side only: the secret key
 * lives in this object and in nothing that reaches a browser. Every call
 *
 * - forwards the request id (`X-Request-Id`), so a Sideout request can be traced into the
 *   Purse calls it caused (spec section 10);
 * - carries an `Idempotency-Key` on every mutation (spec section 2, rule 4); the caller
 *   chooses the key, because which key a mutation reuses is the caller's rule (a
 *   consensus reuses the key minted at `agreed`, a contest's `open` is keyed by the
 *   contest, and so on);
 * - is recorded in `purse_calls` before it is made and completed after it, through the
 *   `CallRecorder` seam, with bodies scrubbed of anything key-shaped;
 * - parses a success through the resource's schema and maps an error envelope to a
 *   `PurseApiError`, so a caller sees Purse's sealed taxonomy and never a raw body.
 */
export type CallSubject = { type: 'tournament' | 'match' | 'user' | 'team'; id: string };

export type CallContext = {
  requestId: string;
  /** Required for mutations; refused on reads. */
  idempotencyKey?: string;
  subject?: CallSubject;
};

export type CallStart = {
  requestId: string;
  method: string;
  path: string;
  idempotencyKey: string | null;
  subject: CallSubject | null;
  /** Already redacted. */
  requestBody: unknown;
  startedAt: Date;
};

export type CallOutcome =
  | { status: 'succeeded' | 'refused'; responseStatus: number; responseBody: unknown; replayed: boolean; finishedAt: Date }
  | { status: 'failed'; error: string; responseStatus: number | null; responseBody: unknown; finishedAt: Date };

/** Where calls are recorded. The database implementation is `calls.ts`; tests pass an in-memory one. */
export type CallRecorder = {
  begin(call: CallStart): Promise<string>;
  finish(callId: string, outcome: CallOutcome): Promise<void>;
}

export type PurseClientOptions = {
  baseUrl: string;
  secretKey: string;
  recorder: CallRecorder;
  fetch?: typeof fetch;
  clock?: () => Date;
  /** How long one call may take before it counts as unreachable. */
  timeoutMs?: number;
  /** Waits between rate-limited attempts; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
};

export type PurseResponse<T> = { data: T; status: number; replayed: boolean; requestId: string };

export type ContestTransitionName = 'open' | 'lock' | 'start' | 'finish';

export type CreateContestInput = {
  externalId: string;
  kind: ContestKind;
  title: string;
  asset: 'POINTS' | 'CREDIT';
  entryAmount: bigint;
  maxParticipants?: number | null;
  prizeStructure: PrizeStructure;
  settlementPolicy?: 'operator_close' | 'auto';
};

export type ScoreSubmissionInput = { userId: string; score: number | null; attemptFinished: boolean; sourceRef?: string | null };

export const DEFAULT_PURSE_TIMEOUT_MS = 10_000;
/** How many times a rate-limited request is sent before the 429 is the answer. */
export const RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_MIN_WAIT_MS = 250;
const RATE_LIMIT_MAX_WAIT_MS = 5000;

const SECRET_KEY_SHAPE = /^sk_(sandbox|live)_[A-Za-z0-9]{32}$/;

export class PurseClient {
  readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly recorder: CallRecorder;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PurseClientOptions) {
    if (!SECRET_KEY_SHAPE.test(options.secretKey)) throw new RangeError('SIDEOUT_PURSE_SECRET_KEY must look like sk_sandbox_... or sk_live_...');
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new RangeError('PURSE_API_URL must be an http(s) URL');
    this.baseUrl = base.origin;
    this.secretKey = options.secretKey;
    this.recorder = options.recorder;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PURSE_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The key's environment, for a log line or the admin page; never the key itself. */
  get environment(): 'sandbox' | 'live' {
    return this.secretKey.startsWith('sk_live_') ? 'live' : 'sandbox';
  }

  // ---- Users ------------------------------------------------------------------------------

  upsertUser(input: { externalId: string; displayName?: string | null; phoneE164?: string | null; dateOfBirth?: string | null; location?: { declaredRegion: string } }, ctx: CallContext) {
    return this.call('POST', '/v1/users', input, userSchema, ctx);
  }

  getUser(userId: string, ctx: CallContext) {
    return this.call('GET', `/v1/users/${encodeURIComponent(userId)}`, undefined, userSchema, ctx);
  }

  getWallet(userId: string, ctx: CallContext) {
    return this.call('GET', `/v1/users/${encodeURIComponent(userId)}/wallet`, undefined, walletSchema, ctx);
  }

  /** Operator scope: the seed key carries it (spec 4.7 `POST /users/:id/credits`). */
  issueCredits(userId: string, input: { asset: 'POINTS' | 'CREDIT'; amount: bigint; description?: string }, ctx: CallContext) {
    return this.call('POST', `/v1/users/${encodeURIComponent(userId)}/credits`, { ...input, amount: input.amount.toString() }, creditSchema, ctx);
  }

  mintEmbedToken(input: { userId: string; flow: EmbedFlow }, ctx: CallContext) {
    return this.call('POST', '/v1/embed/tokens', input, embedTokenSchema, ctx);
  }

  // ---- Contests ---------------------------------------------------------------------------

  createContest(input: CreateContestInput, ctx: CallContext) {
    return this.call('POST', '/v1/contests', { ...input, entryAmount: input.entryAmount.toString() }, contestSchema, ctx);
  }

  getContest(contestId: string, ctx: CallContext) {
    return this.call('GET', `/v1/contests/${encodeURIComponent(contestId)}`, undefined, contestSchema, ctx);
  }

  transitionContest(contestId: string, to: ContestTransitionName, ctx: CallContext, reason?: string) {
    return this.call('POST', `/v1/contests/${encodeURIComponent(contestId)}/${to}`, reason === undefined ? {} : { reason }, contestSchema, ctx);
  }

  enterContest(contestId: string, input: { userId: string; teamRef?: string | null; seed?: number | null }, ctx: CallContext) {
    return this.call('POST', `/v1/contests/${encodeURIComponent(contestId)}/entries`, input, entrySchema, ctx);
  }

  submitScores(contestId: string, scores: readonly ScoreSubmissionInput[], ctx: CallContext) {
    return this.call('POST', `/v1/contests/${encodeURIComponent(contestId)}/scores`, { scores }, scoresSchema, ctx);
  }

  previewContest(contestId: string, ctx: CallContext) {
    return this.call('GET', `/v1/contests/${encodeURIComponent(contestId)}/preview`, undefined, previewSchema, ctx);
  }

  closeContest(contestId: string, payoutHash: string, ctx: CallContext) {
    return this.call('POST', `/v1/contests/${encodeURIComponent(contestId)}/close`, { payoutHash }, settlementSchema, ctx);
  }

  voidContest(contestId: string, ctx: CallContext, reason?: string) {
    return this.call('POST', `/v1/contests/${encodeURIComponent(contestId)}/void`, reason === undefined ? {} : { reason }, voidSchema, ctx);
  }

  getResults(contestId: string, ctx: CallContext) {
    return this.call('GET', `/v1/contests/${encodeURIComponent(contestId)}/results`, undefined, resultsSchema, ctx);
  }

  // ---- Webhooks (the seed and the integration test register Sideout's receiver) ----------

  createWebhookEndpoint(input: { url: string; subscribedEvents: WebhookEventType[]; description?: string }, ctx: CallContext) {
    return this.call('POST', '/v1/webhooks/endpoints', input, webhookEndpointSchema, ctx);
  }

  // ---- The one place a request leaves Sideout for Purse ----------------------------------

  /**
   * A rate-limited answer (429) is retried after Purse's `Retry-After`, a few times: Purse
   * stores no 429 under an idempotency key, so the same request is safe to send again,
   * and a burst of pushes should wait rather than fail. Each attempt is its own recorded call.
   */
  private async call<S extends z.ZodType>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, schema: S, ctx: CallContext): Promise<PurseResponse<z.output<S>>> {
    const mutation = method !== 'GET';
    if (mutation && !isIdempotencyKey(ctx.idempotencyKey)) throw new RangeError(`${method} ${path} needs an Idempotency-Key`);
    if (!mutation && ctx.idempotencyKey !== undefined) throw new RangeError(`${method} ${path} takes no Idempotency-Key`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.once(method, path, body, schema, ctx, mutation);
      } catch (error) {
        if (!(error instanceof PurseApiError) || error.status !== 429 || attempt >= RATE_LIMIT_ATTEMPTS) throw error;
        await this.sleep(Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(RATE_LIMIT_MIN_WAIT_MS, error.retryAfterMs ?? RATE_LIMIT_MIN_WAIT_MS)));
      }
    }
  }

  private async once<S extends z.ZodType>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, schema: S, ctx: CallContext, mutation: boolean): Promise<PurseResponse<z.output<S>>> {
    const startedAt = this.clock();
    const callId = await this.recorder.begin({
      requestId: ctx.requestId,
      method,
      path,
      idempotencyKey: mutation ? (ctx.idempotencyKey ?? null) : null,
      subject: ctx.subject ?? null,
      requestBody: body === undefined ? null : redact(body),
      startedAt,
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      accept: 'application/json',
      [REQUEST_ID_HEADER]: ctx.requestId,
    };
    if (mutation && ctx.idempotencyKey !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = ctx.idempotencyKey;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const message = redactString(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      await this.recorder.finish(callId, { status: 'failed', error: message, responseStatus: null, responseBody: null, finishedAt: this.clock() });
      throw new PurseUnreachableError(`Purse did not answer ${method} ${path}: ${message}`, ctx.requestId, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      await this.recorder.finish(callId, { status: 'failed', error: `non-JSON body (${response.status})`, responseStatus: response.status, responseBody: null, finishedAt: this.clock() });
      throw new PurseUnreachableError(`Purse answered ${method} ${path} with ${response.status} and a body that is not JSON`, ctx.requestId);
    }
    const replayed = response.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true';
    const stored = redact(parsed);

    if (!response.ok) {
      const envelope = errorEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        await this.recorder.finish(callId, { status: 'failed', error: `unrecognised error body (${response.status})`, responseStatus: response.status, responseBody: stored, finishedAt: this.clock() });
        throw new PurseResponseError(`Purse answered ${method} ${path} with ${response.status} and no error envelope`, response.status, ctx.requestId);
      }
      await this.recorder.finish(callId, { status: 'refused', responseStatus: response.status, responseBody: stored, replayed, finishedAt: this.clock() });
      const { type, code, message, detail } = envelope.data.error;
      const retryAfter = Number(response.headers.get(RETRY_AFTER_HEADER) ?? '');
      throw new PurseApiError(response.status, { type, code, message, ...(detail === undefined ? {} : { detail }) }, ctx.requestId, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    }

    const data = typeof parsed === 'object' && parsed !== null && 'data' in parsed ? (parsed).data : undefined;
    const resource = schema.safeParse(data);
    if (!resource.success) {
      await this.recorder.finish(callId, { status: 'failed', error: `response did not match the resource schema (${response.status})`, responseStatus: response.status, responseBody: stored, finishedAt: this.clock() });
      throw new PurseResponseError(`Purse answered ${method} ${path} with ${response.status} but the body did not match the resource: ${resource.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, response.status, ctx.requestId);
    }
    await this.recorder.finish(callId, { status: 'succeeded', responseStatus: response.status, responseBody: stored, replayed, finishedAt: this.clock() });
    return { data: resource.data, status: response.status, replayed, requestId: ctx.requestId };
  }
}
