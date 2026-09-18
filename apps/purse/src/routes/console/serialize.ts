import type {
  AccountDetailResource,
  AccountEntryResource,
  AccountResource,
  ApiKeyResource,
  AuditRowResource,
  ConsoleDeliveryResource,
  ConsoleEndpointResource,
  ConsoleRestrictionResource,
  ContestSummaryResource,
  EntryDetailResource,
  EntrySummaryResource,
  JournalEntryResource,
  JournalLineResource,
  OperatorFlagResource,
  RulesetResource,
  RulesetSummaryResource,
  TenantResource,
  UserSummaryResource,
} from '@purse/types';

import type { BrowsedContest } from '../../contests';
import type { ApiKey, AuditRow, JournalEntry, JournalLine, OperatorFlag, RulesetRow, Tenant, UserRestriction, WebhookEndpoint } from '../../db/schema';
import type { AccountDetail, AccountEntry, AccountSummary, EntryDetail, EntrySummary } from '../../ledger';
import type { FoundUser } from '../../users';
import type { DeliveryWithAttempts } from '../../webhooks';
import { contestResource, deliveryResource, endpointResource } from '../v1/serialize';

/**
 * Rows to the console's wire shapes (`@purse/types`, `console.ts`). The v1 serializers are
 * reused where a shape is shared; what is added here is what only an operator sees (a key's
 * last use, an operator's reason for a restriction, a flag's detail, a ledger line).
 */
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function tenantResource(tenant: Tenant, counts: TenantResource['counts']): TenantResource {
  return { id: tenant.id, name: tenant.name, status: tenant.status, createdAt: tenant.createdAt.toISOString(), updatedAt: tenant.updatedAt.toISOString(), counts };
}

export function apiKeyResource(key: Omit<ApiKey, 'keyHash'>, plaintext: string | null): ApiKeyResource {
  return {
    id: key.id,
    tenantId: key.tenantId,
    kind: key.kind,
    environment: key.environment,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    label: key.label,
    lastUsedAt: iso(key.lastUsedAt),
    revokedAt: iso(key.revokedAt),
    createdAt: key.createdAt.toISOString(),
    plaintext,
  };
}

export function consoleEndpointResource(endpoint: WebhookEndpoint, secret: string | null): ConsoleEndpointResource {
  return { ...endpointResource(endpoint, secret), tenantId: endpoint.tenantId };
}

export function consoleDeliveryResource(delivery: DeliveryWithAttempts, context: { tenantName: string; endpointUrl: string }): ConsoleDeliveryResource {
  return { ...deliveryResource(delivery), tenantId: delivery.delivery.tenantId, tenantName: context.tenantName, endpointUrl: context.endpointUrl };
}

export function contestSummaryResource(browsed: BrowsedContest): ContestSummaryResource {
  return { ...contestResource(browsed.contest, browsed.escrowBalance, browsed.participantCount), tenantId: browsed.contest.tenantId, tenantName: browsed.tenantName };
}

export function flagResource(flag: OperatorFlag, users: OperatorFlagResource['users']): OperatorFlagResource {
  return {
    id: flag.id,
    tenantId: flag.tenantId,
    kind: flag.kind,
    subject: flag.subject,
    detail: flag.detail,
    status: flag.status,
    reviewedAt: iso(flag.reviewedAt),
    reviewedBy: flag.reviewedBy,
    createdAt: flag.createdAt.toISOString(),
    users,
  };
}

/** The ids a flag names: its subject and, for a pair, the `users` array in its detail. */
export function flaggedUserIds(flag: OperatorFlag): string[] {
  const listed = flag.detail['users'];
  const pair = Array.isArray(listed) ? listed.filter((each): each is string => typeof each === 'string') : [];
  return [...new Set([flag.subject, ...pair].filter((each) => each.startsWith('usr_')))];
}

export function consoleRestrictionResource(row: UserRestriction, now: Date): ConsoleRestrictionResource {
  const active = row.liftedAt === null && row.startsAt.getTime() <= now.getTime() && (row.endsAt === null || row.endsAt.getTime() > now.getTime());
  return {
    id: row.id,
    kind: row.kind,
    reason: row.reason,
    startsAt: row.startsAt.toISOString(),
    endsAt: iso(row.endsAt),
    createdBy: row.createdBy,
    liftedAt: iso(row.liftedAt),
    liftedBy: row.liftedBy,
    active,
  };
}

export function userSummaryResource(found: FoundUser): UserSummaryResource {
  return {
    id: found.user.id,
    externalId: found.user.externalId,
    displayName: found.user.displayName,
    phoneE164: found.user.phoneE164,
    verificationState: found.verificationState,
    createdAt: found.user.createdAt.toISOString(),
  };
}

export function accountResource(summary: AccountSummary): AccountResource {
  return {
    id: summary.id,
    tenantId: summary.tenantId,
    kind: summary.kind,
    asset: summary.asset,
    normalSide: summary.normalSide,
    status: summary.status,
    owner: summary.owner,
    balance: summary.balance.toString(),
    lineCount: summary.lineCount,
    createdAt: summary.createdAt.toISOString(),
  };
}

export function accountDetailResource(detail: AccountDetail): AccountDetailResource {
  return {
    ...accountResource(detail),
    asOf: detail.asOf === null ? null : { at: detail.asOf.at.toISOString(), balance: detail.asOf.balance.toString() },
    firstPostedAt: iso(detail.firstPostedAt),
    lastPostedAt: iso(detail.lastPostedAt),
  };
}

export function journalEntryResource(entry: JournalEntry): JournalEntryResource {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    kind: entry.kind,
    description: entry.description,
    idempotencyKey: entry.idempotencyKey,
    contestId: entry.contestId,
    reversesEntryId: entry.reversesEntryId,
    postedAt: entry.postedAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function journalLineResource(line: JournalLine): JournalLineResource {
  return { id: line.id, sequence: line.sequence, accountId: line.accountId, direction: line.direction, amount: line.amount.toString(), asset: line.asset };
}

export function accountEntryResource(item: AccountEntry): AccountEntryResource {
  return { entry: journalEntryResource(item.entry), line: journalLineResource(item.line), delta: item.delta.toString(), balanceAfter: item.balanceAfter.toString() };
}

export function entrySummaryResource(item: EntrySummary): EntrySummaryResource {
  return { entry: journalEntryResource(item.entry), lineCount: item.lineCount, asset: item.asset, amount: item.amount.toString() };
}

export function entryDetailResource(detail: EntryDetail): EntryDetailResource {
  return {
    entry: journalEntryResource(detail.entry),
    lines: detail.lines.map((each) => ({ line: journalLineResource(each.line), account: accountResource(each.account), delta: each.delta.toString() })),
    totals: detail.totals.map((each) => ({ asset: each.asset, debits: each.debits.toString(), credits: each.credits.toString(), balanced: each.balanced })),
    balanced: detail.balanced,
    reverses: detail.reverses === null ? null : journalEntryResource(detail.reverses),
    reversedBy: detail.reversedBy === null ? null : journalEntryResource(detail.reversedBy),
    contest: detail.contest,
  };
}

export function rulesetResource(row: RulesetRow): RulesetResource {
  return { version: row.version, active: row.active, body: row.body, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function rulesetSummaryResource(row: RulesetRow): RulesetSummaryResource {
  return { version: row.version, active: row.active, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function auditRowResource(row: AuditRow): AuditRowResource {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actorKind: row.actorKind,
    actorRef: row.actorRef,
    action: row.action,
    subject: row.subject,
    before: row.before,
    after: row.after,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}
