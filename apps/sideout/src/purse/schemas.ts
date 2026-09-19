import {
  API_ERROR_TYPES,
  ASSETS,
  ATTESTATION_ALGORITHMS,
  ATTESTATION_STATES,
  CONTEST_KINDS,
  CONTEST_STATES,
  EMBED_FLOWS,
  LOCATION_SOURCES,
  PARTICIPANT_STATES,
  RESTRICTION_KINDS,
  SETTLEMENT_POLICIES,
  TIE_BREAK_RULES,
  VERIFICATION_STATES,
  WEBHOOK_EVENT_TYPES,
  type ApiError,
  type CanonicalValue,
  type ContestResource,
  type CreditResource,
  type DeviceResource,
  type EmbedTokenResource,
  type EntryResource,
  type PreviewResource,
  type PrizeStructure,
  type ResultsResource,
  type ScoresResource,
  type SettlementResource,
  type UserResource,
  type VerificationStartResource,
  type VoidResource,
  type WalletResource,
  type WebhookEndpointResource,
} from '@purse/types';
import { z } from 'zod';

/**
 * Zod schemas for the v1 resources Sideout reads (spec 4.7), each held to the matching
 * `@purse/types` shape with `satisfies`, so a response Purse changes under us is a parse
 * failure at the boundary rather than an `undefined` somewhere in a service. Money stays a
 * decimal string (`Money`); nothing here turns an amount into a JavaScript number.
 */
/**
 * A resource type with `undefined` admitted wherever a property is optional: the wire
 * shapes are written with `?:`, this project compiles with `exactOptionalPropertyTypes`,
 * and a parsed optional field is `T | undefined`. Nothing else is loosened.
 */
type Loosen<T> = T extends ReadonlyArray<infer U> ? Array<Loosen<U>> : T extends object ? { [K in keyof T]: undefined extends T[K] ? Loosen<T[K]> | undefined : Loosen<T[K]> } : T;
type Shape<T> = z.ZodType<Loosen<T>>;

const money = z.string().regex(/^(0|-?[1-9][0-9]*)$/, 'minor units as a decimal string');
const instant = z.string().min(1);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f-]{36}$`), `a ${prefix}_ id`);

export const apiErrorSchema = z.looseObject({
  type: z.enum(API_ERROR_TYPES),
  code: z.string().min(1),
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
}) satisfies Shape<ApiError>;

export const errorEnvelopeSchema = z.object({ error: apiErrorSchema });

export const verificationSchema = z.looseObject({
  state: z.enum(VERIFICATION_STATES),
  provider: z.string().nullable(),
  verifiedAt: instant.nullable(),
  reverifyAfter: instant.nullable(),
});

export const restrictionSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(RESTRICTION_KINDS),
  reason: z.string().nullable().optional(),
  startsAt: instant,
  endsAt: instant.nullable(),
});

export const userSchema = z.looseObject({
  id: id('usr'),
  externalId: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  verification: verificationSchema,
  restrictions: z.array(restrictionSchema),
  location: z.looseObject({ regionCode: z.string(), source: z.enum(LOCATION_SOURCES), resolvedAt: instant, confidence: z.number() }).nullable(),
  createdAt: instant,
  updatedAt: instant,
}) satisfies Shape<UserResource>;

export const walletSchema = z.looseObject({
  userId: id('usr'),
  balances: z.array(z.looseObject({ asset: z.enum(ASSETS), balance: money, accountId: z.string().nullable() })),
}) satisfies Shape<WalletResource>;

export const creditSchema = z.looseObject({ userId: id('usr'), asset: z.enum(ASSETS), amount: money, journalEntryId: z.string(), balance: money }) satisfies Shape<CreditResource>;

export const embedTokenSchema = z.looseObject({
  token: z.string().nullable(),
  replayed: z.boolean(),
  flow: z.enum(EMBED_FLOWS),
  userId: id('usr'),
  expiresAt: instant,
}) satisfies Shape<EmbedTokenResource>;

/** What `POST /v1/users/:id/verification` answers: the user, the verification row and a single-use identity embed token. */
export const verificationStartSchema = z.looseObject({
  user: userSchema,
  verification: verificationSchema,
  embedToken: embedTokenSchema,
}) satisfies Shape<VerificationStartResource>;

const amountString = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const prizeStructureSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('winner_take_all'), participationFloor: amountString.optional() }),
  z.looseObject({
    type: z.literal('placement_table'),
    placements: z.union([
      z.array(z.looseObject({ placement: z.number().int(), amount: amountString })),
      z.array(z.looseObject({ placement: z.number().int(), percent: z.number() })),
    ]),
    participationFloor: amountString.optional(),
  }),
  z.looseObject({ type: z.literal('percentage_split'), percentages: z.array(z.number()), participationFloor: amountString.optional() }),
  z.looseObject({ type: z.literal('top_n_equal'), n: z.number().int(), participationFloor: amountString.optional() }),
  z.looseObject({ type: z.literal('guaranteed_minimum'), minimums: z.array(amountString), percentages: z.array(z.number()), participationFloor: amountString.optional() }),
]) satisfies Shape<PrizeStructure>;

export const contestSchema = z.looseObject({
  id: id('cnt'),
  externalId: z.string(),
  kind: z.enum(CONTEST_KINDS),
  title: z.string(),
  asset: z.enum(ASSETS),
  entryAmount: money,
  maxParticipants: z.number().int().nullable(),
  prizeStructure: prizeStructureSchema,
  tieBreak: z.enum(TIE_BREAK_RULES),
  settlementPolicy: z.enum(SETTLEMENT_POLICIES),
  eligibilityRulesetVersion: z.string().nullable(),
  state: z.enum(CONTEST_STATES),
  opensAt: instant.nullable(),
  locksAt: instant.nullable(),
  escrowAccountId: z.string(),
  escrowBalance: money,
  participantCount: z.number().int(),
  settledAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant,
}) satisfies Shape<ContestResource>;

export const participantSchema = z.looseObject({
  id: z.string(),
  contestId: id('cnt'),
  userId: id('usr'),
  teamRef: z.string().nullable(),
  seed: z.number().int().nullable(),
  state: z.enum(PARTICIPANT_STATES),
  joinedAt: instant,
  entryJournalEntryId: z.string(),
});

const eligibilitySchema = z.union([
  z.looseObject({ allowed: z.literal(true), rulesetVersion: z.string() }),
  z.looseObject({ allowed: z.literal(false), rulesetVersion: z.string(), reasons: z.array(z.string()), requiredAction: z.string().optional() }),
]);

export const entrySchema = z.looseObject({
  contest: contestSchema,
  participant: participantSchema,
  eligibility: eligibilitySchema,
  journalEntryId: z.string(),
}) satisfies Shape<Omit<EntryResource, 'eligibility'> & { eligibility: unknown }>;

/** A P-256 public JWK as Purse echoes it back; the private scalar can never appear here. */
export const publicJwkSchema = z.strictObject({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() });

/** The canonical value grammar of a signed payload: JSON with integers only. */
const canonicalValueSchema: z.ZodType<CanonicalValue> = z.lazy(() => z.union([z.string(), z.int(), z.boolean(), z.null(), z.array(canonicalValueSchema), z.record(z.string(), canonicalValueSchema)]));

/** What Purse recorded about a score's device signature (`@purse/types` `attestation.ts`); read for the record, never re-verified here. */
export const scoreAttestationSchema = z.looseObject({
  state: z.enum(['verified', 'unverified']),
  deviceId: z.string().nullable(),
  userId: id('usr'),
  keyId: z.string(),
  algorithm: z.enum(ATTESTATION_ALGORITHMS),
  signature: z.string(),
  timestamp: instant,
  refs: z.record(z.string(), z.string()),
  content: canonicalValueSchema,
  checkedAt: instant,
});

export const scoreSchema = z.looseObject({
  id: z.string(),
  contestId: id('cnt'),
  userId: id('usr'),
  score: z.number().nullable(),
  attemptFinished: z.boolean(),
  submittedAt: instant,
  sourceRef: z.string().nullable(),
  attestationState: z.enum(ATTESTATION_STATES),
  attestation: scoreAttestationSchema.nullable(),
});

export const deviceSchema = z.looseObject({
  id: id('udv'),
  userId: id('usr'),
  keyId: z.string(),
  algorithm: z.enum(ATTESTATION_ALGORITHMS),
  publicKey: publicJwkSchema,
  label: z.string().nullable(),
  registeredAt: instant,
  revokedAt: instant.nullable(),
  revokedReason: z.string().nullable(),
}) satisfies Shape<DeviceResource>;

export const resultSchema = z.looseObject({
  id: z.string(),
  contestId: id('cnt'),
  userId: id('usr'),
  placement: z.number().int(),
  score: z.number().nullable(),
  payoutAmount: money,
  payoutJournalEntryId: z.string().nullable(),
  computedAt: instant,
});

export const settlementSchema = z.looseObject({
  contest: contestSchema,
  results: z.array(resultSchema),
  payoutHash: z.string().regex(/^[0-9a-f]{64}$/),
  journalEntryId: z.string().nullable(),
}) satisfies Shape<SettlementResource>;

export const scoresSchema = z.looseObject({ contest: contestSchema, scores: z.array(scoreSchema), settlement: settlementSchema.nullable() }) satisfies Shape<ScoresResource>;

export const previewSchema = z.looseObject({
  contestId: id('cnt'),
  state: z.enum(CONTEST_STATES),
  escrowTotal: money,
  entries: z.array(
    z.looseObject({
      userId: id('usr'),
      participantId: z.string(),
      participantState: z.enum(PARTICIPANT_STATES),
      score: z.number().nullable(),
      seed: z.number().int().nullable(),
      attemptFinished: z.boolean(),
    }),
  ),
  payouts: z.array(z.looseObject({ userId: id('usr'), placement: z.number().int(), payout: money })),
  payoutHash: z.string().regex(/^[0-9a-f]{64}$/),
}) satisfies Shape<PreviewResource>;

export const resultsSchema = z.looseObject({ contestId: id('cnt'), state: z.enum(CONTEST_STATES), settledAt: instant.nullable(), results: z.array(resultSchema) }) satisfies Shape<ResultsResource>;

export const voidSchema = z.looseObject({ contest: contestSchema, refundJournalEntryIds: z.array(z.string()) }) satisfies Shape<VoidResource>;

export const webhookEndpointSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  subscribedEvents: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  status: z.enum(['enabled', 'disabled']),
  description: z.string().nullable(),
  secret: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
}) satisfies Shape<WebhookEndpointResource>;

/** The envelope every webhook delivery carries (spec 4.9); `data` is checked per type by the receiver. */
export const webhookEventEnvelopeSchema = z.looseObject({
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  createdAt: instant,
  tenantId: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** The parsed shapes, as the services see them: the `@purse/types` resources with optional fields admitting `undefined`. */
export type ParsedUser = z.output<typeof userSchema>;
export type ParsedWallet = z.output<typeof walletSchema>;
export type ParsedContest = z.output<typeof contestSchema>;
export type ParsedEntry = z.output<typeof entrySchema>;
export type ParsedScores = z.output<typeof scoresSchema>;
export type ParsedPreview = z.output<typeof previewSchema>;
export type ParsedSettlement = z.output<typeof settlementSchema>;
export type ParsedEmbedToken = z.output<typeof embedTokenSchema>;
export type ParsedVerificationStart = z.output<typeof verificationStartSchema>;
export type ParsedDevice = z.output<typeof deviceSchema>;
