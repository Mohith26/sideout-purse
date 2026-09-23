import type { EligibilityDecision } from './eligibility';
import type {
  ApiKeyEnvironment,
  ApiKeyKind,
  Asset,
  ContestResource,
  ContestState,
  Money,
  ParticipantResource,
  PreviewResource,
  RestrictionKind,
  ResultResource,
  ScoreResource,
  SettlementResource,
  UserResource,
  VerificationState,
} from './resources';
import type { WebhookDeliveryResource, WebhookEndpointResource } from './webhooks';

/**
 * The operator console's wire shapes (system spec 4.10): what `apps/purse/src/routes/console`
 * returns and `apps/purse-console` renders. The console app imports nothing of the API's
 * source, so the contract lives here, like the v1 resources. Same conventions: money is a
 * decimal string, instants are ISO 8601, ids carry their prefix, and nothing internal (a
 * hash, a secret envelope, a password) ever appears.
 */

export const OPERATOR_ROLES = ['admin', 'operator'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export const TENANT_STATUSES = ['active', 'suspended', 'retired'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const ACCOUNT_KINDS = ['user_wallet', 'contest_escrow', 'sponsor_funding', 'promo_liability', 'platform_fee', 'external_settlement'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_STATUSES = ['open', 'frozen', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const LEDGER_SIDES = ['debit', 'credit'] as const;
export type LedgerSide = (typeof LEDGER_SIDES)[number];

export const JOURNAL_ENTRY_KINDS = [
  'issue',
  'escrow',
  'refund',
  'settle',
  'void',
  'reversal',
  'adjustment',
  // Treasury (spec section 14): the in-ledger leg of a payment, and the platform's rake.
  'deposit',
  'withdrawal',
  'fee',
] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

export const OPERATOR_FLAG_KINDS = ['duplicate_identity', 'collusion_signal', 'risk_review'] as const;
export type OperatorFlagKind = (typeof OPERATOR_FLAG_KINDS)[number];

export const OPERATOR_FLAG_STATUSES = ['open', 'reviewed', 'dismissed'] as const;
export type OperatorFlagStatus = (typeof OPERATOR_FLAG_STATUSES)[number];

/** The restrictions an operator may place from the console; the other two are the user's own. */
export const OPERATOR_RESTRICTION_KINDS = ['platform_block', 'velocity_lock', 'cool_off'] as const satisfies readonly RestrictionKind[];

export const INVARIANT_STATUSES = ['ok', 'failed', 'not_applicable'] as const;

// ---- Auth ------------------------------------------------------------------------------

export type OperatorResource = { id: string; email: string; role: OperatorRole; createdAt: string };

/** What a sign-in returns: the token travels once, to the console's server, which keeps it in an HttpOnly cookie. */
export type ConsoleSessionResource = { operator: OperatorResource; sessionId: string; token: string; expiresAt: string };

export type ConsoleMeResource = { operator: OperatorResource; sessionId: string; expiresAt: string };

// ---- Tenants and keys ------------------------------------------------------------------

export type TenantResource = {
  id: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
  counts: { apiKeys: number; users: number; contests: number; webhookEndpoints: number };
};

export type TenantDetailResource = TenantResource & { origins: string[] };

/** A key as the console shows it: prefix, environment, scopes, last use; never the hash. `plaintext` is set once, at creation. */
export type ApiKeyResource = {
  id: string;
  tenantId: string;
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
  keyPrefix: string;
  scopes: string[];
  label: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  plaintext: string | null;
};

// ---- Webhooks ----------------------------------------------------------------------------

export type ConsoleDeliveryResource = WebhookDeliveryResource & { tenantId: string; tenantName: string; endpointUrl: string };

export type ConsoleEndpointResource = WebhookEndpointResource & { tenantId: string };

// ---- Contests ----------------------------------------------------------------------------

export type ContestSummaryResource = ContestResource & { tenantId: string; tenantName: string };

export type ContestEntrantResource = ParticipantResource & { externalId: string; displayName: string | null };

export type ContestDetailResource = {
  contest: ContestSummaryResource;
  participants: ContestEntrantResource[];
  scores: ScoreResource[];
  results: ResultResource[];
};

export type ConsoleSettlementResource = SettlementResource & { replayed: boolean };

export type ConsolePreviewResource = PreviewResource;

// ---- Review queues -------------------------------------------------------------------------

export type OperatorFlagResource = {
  id: string;
  tenantId: string;
  kind: OperatorFlagKind;
  subject: string;
  detail: Record<string, unknown>;
  status: OperatorFlagStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  /** The users the flag names (the subject and, for a pair, both sides), described for the queue. */
  users: Array<{ id: string; externalId: string; displayName: string | null }>;
};

export type ConsoleRestrictionResource = {
  id: string;
  kind: RestrictionKind;
  reason: string | null;
  startsAt: string;
  endsAt: string | null;
  createdBy: string;
  liftedAt: string | null;
  liftedBy: string | null;
  /** In force now: started, not ended, not lifted. */
  active: boolean;
};

export type ConsoleUserResource = {
  user: UserResource;
  /** Every restriction, lifted and expired ones included, newest first. */
  restrictions: ConsoleRestrictionResource[];
  wallets: Array<{ asset: Asset; accountId: string | null; balance: Money }>;
  openFlags: OperatorFlagResource[];
  recentDecisions: Array<{ id: string; contestId: string; allowed: boolean; reasons: string[]; rulesetVersion: string; createdAt: string }>;
};

export type UserSummaryResource = {
  id: string;
  externalId: string;
  displayName: string | null;
  phoneE164: string | null;
  verificationState: VerificationState;
  createdAt: string;
};

// ---- Ledger explorer -------------------------------------------------------------------

export type AccountOwnerResource =
  | { kind: 'user'; id: string; externalId: string; displayName: string | null }
  | { kind: 'contest'; id: string; title: string; state: ContestState }
  | null;

export type AccountResource = {
  id: string;
  tenantId: string;
  kind: AccountKind;
  asset: Asset;
  normalSide: LedgerSide;
  status: AccountStatus;
  owner: AccountOwnerResource;
  balance: Money;
  lineCount: number;
  createdAt: string;
};

export type AccountDetailResource = AccountResource & {
  asOf: { at: string; balance: Money } | null;
  firstPostedAt: string | null;
  lastPostedAt: string | null;
};

export type JournalEntryResource = {
  id: string;
  tenantId: string;
  kind: JournalEntryKind;
  description: string;
  idempotencyKey: string;
  contestId: string | null;
  reversesEntryId: string | null;
  postedAt: string;
  createdAt: string;
};

export type JournalLineResource = {
  id: string;
  sequence: number;
  accountId: string;
  direction: LedgerSide;
  amount: Money;
  asset: Asset;
};

export type AccountEntryResource = {
  entry: JournalEntryResource;
  line: JournalLineResource;
  /** The line's effect on the account, signed relative to its normal side. */
  delta: Money;
  balanceAfter: Money;
};

export type EntrySummaryResource = { entry: JournalEntryResource; lineCount: number; asset: Asset | null; amount: Money };

export type EntryDetailResource = {
  entry: JournalEntryResource;
  lines: Array<{ line: JournalLineResource; account: AccountResource; delta: Money }>;
  totals: Array<{ asset: Asset; debits: Money; credits: Money; balanced: boolean }>;
  balanced: boolean;
  reverses: JournalEntryResource | null;
  reversedBy: JournalEntryResource | null;
  contest: { id: string; title: string; state: ContestState } | null;
};

export type PageResource<T> = { items: T[]; nextCursor: string | null };

// ---- Invariants ---------------------------------------------------------------------------

export type InvariantResource = {
  id: string;
  name: string;
  ok: boolean;
  status: (typeof INVARIANT_STATUSES)[number];
  detail: string;
  notApplicableUntil?: string;
};

export type ReconcileResource = { ok: boolean; ranAt: string; durationMs: number; invariants: InvariantResource[] };

// ---- Rulesets ----------------------------------------------------------------------------

export type RulesetResource = { version: string; active: boolean; body: Record<string, unknown>; createdAt: string; updatedAt: string };

export type RulesetSummaryResource = Omit<RulesetResource, 'body'>;

/** The tester's input (spec 4.10 "what would this decide"): the evaluator's documented input with money as strings. */
export type RulesetTestInput = {
  rulesetVersion?: string;
  user: {
    dateOfBirth: string | null;
    verificationState: VerificationState;
    reverifyAfter?: string | null;
    restrictions: Array<{ kind: RestrictionKind; startsAt: string; endsAt: string | null }>;
    region: string | null;
  };
  contest: { asset: Asset; entryAmount: Money; kind: 'tournament' | 'head_to_head' | 'pool' };
  wallet: { balance: Money };
  velocity: { enteredLast24h: Money; enteredLast7d: Money };
  asOf?: string;
};

export type RulesetTestResource = { rulesetVersion: string; asOf: string; decision: EligibilityDecision };

// ---- Audit ---------------------------------------------------------------------------------

export type AuditRowResource = {
  id: string;
  tenantId: string | null;
  actorKind: 'system' | 'operator' | 'tenant' | 'user';
  actorRef: string | null;
  action: string;
  subject: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
};

/** Historical money; account names and ownership are current metadata. */
export type ReplayAccountResource = {
  id: string;
  kind: AccountKind;
  asset: Asset;
  normalSide: LedgerSide;
  ownerRef: string | null;
  label: string;
  balance: Money;
  /** Change caused by the selected entry, relative to the immediately preceding entry. */
  delta: Money;
  lineCount: number;
};

export type LedgerReplayResource = {
  /** One-based in (posted_at, id) order; zero only for an empty journal. */
  position: number;
  total: number;
  entry: JournalEntryResource | null;
  accounts: ReplayAccountResource[];
  accountCount: number;
  accountLimit: number;
  nextAccountCursor: string | null;
  changedAccountIds: string[];
  /** All escrows with journal activity up to this position, regardless of account pagination. */
  escrows: ReplayAccountResource[];
  lines: JournalLineResource[];
  /** Credit-positive, debit-negative account balances summed across the entire tenant. */
  totals: Array<{ asset: Asset; net: Money }>;
  entryTotals: Array<{ asset: Asset; debits: Money; credits: Money }>;
};
