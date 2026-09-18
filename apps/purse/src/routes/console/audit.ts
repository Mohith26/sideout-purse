import { and, desc, eq, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { auditLog } from '../../db/schema';
import { ok } from '../../http/envelope';
import { RequestValidationError } from '../../http/errors';
import type { ConsoleDeps, ConsoleScope } from './scope';
import { auditRowResource } from './serialize';

/**
 * `/console/audit`: the audit log by subject, action or tenant, newest first. The console
 * shows it on a user, a contest, a flag and a ruleset so an operator sees who did what.
 */
const querySchema = z
  .object({
    subject: z.string().trim().min(1).max(255).optional(),
    action: z.string().trim().min(1).max(100).optional(),
    tenantId: z.string().regex(/^tnt_[0-9a-f-]{36}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export function auditRoutes(_deps: ConsoleDeps) {
  const routes = new Hono<ConsoleScope>();

  routes.get('/', async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) throw new RequestValidationError(parsed.error, ['query']);
    const conditions: SQL[] = [];
    if (parsed.data.subject !== undefined) conditions.push(eq(auditLog.subject, parsed.data.subject));
    if (parsed.data.action !== undefined) conditions.push(eq(auditLog.action, parsed.data.action));
    if (parsed.data.tenantId !== undefined) conditions.push(eq(auditLog.tenantId, parsed.data.tenantId));
    const rows = await c
      .get('db')
      .select()
      .from(auditLog)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(Math.min(Math.max(parsed.data.limit ?? 50, 1), 200));
    return ok(c, { audit: rows.map(auditRowResource) });
  });

  return routes;
}
