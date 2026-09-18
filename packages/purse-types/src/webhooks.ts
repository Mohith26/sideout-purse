import type { Asset, ContestKind, ContestState, Money, VerificationResource, VerificationState } from './resources';

/**
 * Outbound webhooks (spec 4.9). Purse posts one JSON `WebhookEvent` per event to every
 * enabled endpoint of the tenant that subscribes to its type, signed with the endpoint's
 * secret (`Purse-Signature`). The payload's `id` is the event's, the same on every attempt
 * and every replay of the same event, and a receiver dedupes on it. `@purse/sdk` ships
 * `verifyWebhook` so partners share one implementation of the signature check.
 */
export const WEBHOOK_EVENT_TYPES = [
  'user.verification.updated',
  'contest.opened',
  'contest.locked',
  'contest.settled',
  'contest.voided',
  'contest.entry.created',
  'contest.entry.withdrawn',
  'wallet.balance.changed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** `Purse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "{t}.{rawBody}">`. */
export const WEBHOOK_SIGNATURE_HEADER = 'Purse-Signature';
/** The event's id, also carried in the payload; a convenience for logs and dedupe before parsing. */
export const WEBHOOK_EVENT_ID_HEADER = 'Purse-Event-Id';
/** The delivery attempt's id, distinct per attempt, for support conversations. */
export const WEBHOOK_DELIVERY_ID_HEADER = 'Purse-Delivery-Id';
/** A signature whose timestamp is further than this from the receiver's clock is a replay (spec 4.9). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type ContestEventData = {
  contestId: string;
  externalId: string;
  kind: ContestKind;
  asset: Asset;
  state: ContestState;
  previousState: ContestState;
  settledAt: string | null;
};

export type WebhookEventData = {
  'user.verification.updated': {
    userId: string;
    externalId: string;
    previousState: VerificationState;
    verification: VerificationResource;
  };
  'contest.opened': ContestEventData;
  'contest.locked': ContestEventData;
  'contest.settled': ContestEventData;
  'contest.voided': ContestEventData;
  'contest.entry.created': {
    contestId: string;
    externalId: string;
    userId: string;
    participantId: string;
    teamRef: string | null;
    seed: number | null;
    journalEntryId: string;
    rulesetVersion: string;
    /** True when a withdrawn entrant came back rather than entering for the first time. */
    reentered: boolean;
  };
  'contest.entry.withdrawn': {
    contestId: string;
    externalId: string;
    userId: string;
    participantId: string;
    refundJournalEntryId: string;
  };
  'wallet.balance.changed': {
    userId: string;
    accountId: string;
    asset: Asset;
    /** The balance after the entry. */
    balance: Money;
    /** Signed: negative when the wallet was debited. */
    delta: Money;
    journalEntryId: string;
    /** The journal entry kind that moved it: `issue`, `escrow`, `refund`, `settle`, `void`, `reversal`, `adjustment`. */
    entryKind: string;
    contestId: string | null;
  };
};

export type WebhookEvent<T extends WebhookEventType = WebhookEventType> = {
  [K in T]: {
    /** `evt_...`, stable across attempts and replays: the key a receiver dedupes on. */
    id: string;
    type: K;
    /** ISO 8601, the instant the event was recorded in Purse. */
    createdAt: string;
    tenantId: string;
    data: WebhookEventData[K];
  };
}[T];

export const WEBHOOK_ENDPOINT_STATUSES = ['enabled', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * An endpoint as the API returns it. `secret` is the signing secret, present only in the
 * response that created or rotated it (`whsec_...`); every other read carries `null`.
 */
export type WebhookEndpointResource = {
  id: string;
  url: string;
  subscribedEvents: WebhookEventType[];
  status: WebhookEndpointStatus;
  description: string | null;
  secret: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDeliveryAttemptResource = {
  id: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  responseStatus: number | null;
  /** Why no response arrived: a timeout, a refused connection. Never a response body. */
  error: string | null;
  durationMs: number;
};

/**
 * One delivery: an event to an endpoint, with the attempts made so far. `status` is
 * `pending` while attempts remain (the next one is due at `nextAttemptAt`), `failed`
 * between a refused attempt and the next, `delivered` on a 2xx, and `dead` after the
 * last attempt of the schedule. A replay is a new delivery of the same event, `replayOf`
 * naming the one it repeats.
 */
export type WebhookDeliveryResource = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempt: number;
  maxAttempts: number;
  responseStatus: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  replayOf: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: WebhookDeliveryAttemptResource[];
};
