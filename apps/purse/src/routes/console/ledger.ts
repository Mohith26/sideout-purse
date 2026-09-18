import { Hono } from 'hono';
import { z } from 'zod';
import { JOURNAL_ENTRY_KINDS, type PageResource, type AccountEntryResource, type EntrySummaryResource, type ReconcileResource } from '@purse/types';
import type { Id } from '@repo/ids';

import { ok } from '../../http/envelope';
import { RequestValidationError } from '../../http/errors';
import { accountDetail, accountEntries, accountSummary, accountTree, decodeCursor, entryDetail, listEntries, reconcile } from '../../ledger';
import { param } from '../v1/schemas';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { accountDetailResource, accountEntryResource, accountResource, entryDetailResource, entrySummaryResource } from './serialize';
import { tenantOf } from './tenants';

/**
 * The ledger explorer and the invariant panel (spec 4.10, "the two screens to show an
 * engineer"): a tenant's account tree with derived balances, one account with its
 * balance now and as of any instant (`balanceOf(asOf)`), the entries that touched it
 * with a running balance, the journal, one entry with every line and the per-asset sums
 * that show it balances, and `reconcile()` on demand. Reads only; nothing here writes.
 */
const accountIdSchema = z.string().regex(/^acct_[0-9a-f-]{36}$/, 'must be an account id (acct_...)');
const entryIdSchema = z.string().regex(/^je_[0-9a-f-]{36}$/, 'must be a journal entry id (je_...)');
const cursorSchema = z.string().regex(/^\d{1,15}:je_[0-9a-f-]{36}$/, 'must be a journal cursor').optional();
const limitSchema = z.coerce.number().int().min(1).max(200).optional();

const accountQuerySchema = z.object({ asOf: z.string().datetime({ offset: true }).optional() }).strict();
const pageQuerySchema = z.object({ cursor: cursorSchema, limit: limitSchema }).strict();
const journalQuerySchema = z
  .object({ kind: z.enum(JOURNAL_ENTRY_KINDS).optional(), contestId: z.string().regex(/^cnt_[0-9a-f-]{36}$/).optional(), cursor: cursorSchema, limit: limitSchema })
  .strict();

function query<S extends z.ZodType>(schema: S, raw: Record<string, string>): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new RequestValidationError(parsed.error, ['query']);
  return parsed.data;
}

export function tenantLedgerRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/accounts', async (c) => {
    const tenant = tenantOf(c);
    const tree = await accountTree(c.get('db'), tenant.id as Id<'tnt'>);
    return ok(c, { accounts: tree.map(accountResource) });
  });

  routes.get('/entries', async (c) => {
    const tenant = tenantOf(c);
    const q = query(journalQuerySchema, c.req.query());
    const page = await listEntries(c.get('db'), {
      tenantId: tenant.id as Id<'tnt'>,
      ...(q.kind === undefined ? {} : { kind: q.kind }),
      ...(q.contestId === undefined ? {} : { contestId: q.contestId }),
      ...(q.limit === undefined ? {} : { limit: q.limit }),
      ...(q.cursor === undefined ? {} : { cursor: decodeCursor(q.cursor) }),
    });
    const body: PageResource<EntrySummaryResource> = { items: page.items.map(entrySummaryResource), nextCursor: page.nextCursor };
    return ok(c, body);
  });

  return routes;
}

export function globalLedgerRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/accounts/:id', async (c) => {
    const accountId = param(accountIdSchema, 'id', c.req.param('id'));
    const q = query(accountQuerySchema, c.req.query());
    const detail = await accountDetail(c.get('db'), accountId, q.asOf === undefined ? undefined : new Date(q.asOf));
    return ok(c, accountDetailResource(detail));
  });

  routes.get('/accounts/:id/entries', async (c) => {
    const accountId = param(accountIdSchema, 'id', c.req.param('id'));
    const q = query(pageQuerySchema, c.req.query());
    const account = await accountSummary(c.get('db'), accountId);
    const page = await accountEntries(c.get('db'), account, { ...(q.limit === undefined ? {} : { limit: q.limit }), ...(q.cursor === undefined ? {} : { cursor: decodeCursor(q.cursor) }) });
    const body: PageResource<AccountEntryResource> = { items: page.items.map(accountEntryResource), nextCursor: page.nextCursor };
    return ok(c, body);
  });

  routes.get('/entries/:id', async (c) => {
    const entryId = param(entryIdSchema, 'id', c.req.param('id'));
    return ok(c, entryDetailResource(await entryDetail(c.get('db'), entryId)));
  });

  // Always 200 with the report, unlike /internal/reconcile: the panel renders a failed
  // invariant red rather than an error envelope, and the log still alarms.
  routes.get('/reconcile', async (c) => {
    const report = await reconcile(c.get('db'));
    const logger = c.get('logger');
    if (report.ok) logger.info('reconcile clean (console)', { durationMs: report.durationMs });
    else logger.error('reconcile failed (console)', { failed: report.invariants.filter((each) => !each.ok).map((each) => each.id) });
    const body: ReconcileResource = report;
    return ok(c, body);
  });

  return routes;
}
