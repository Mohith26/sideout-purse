import type { Sql } from '@repo/db';

/**
 * The append-only guarantee is a property of the role the process connects as. This is
 * checked once at boot: a Purse API started on the migrator's connection string (or on a
 * role someone granted too much) refuses to serve, because an API that could rewrite the
 * journal is exactly what spec 4.2.2 rule 5 forbids. The audit log is held to the same
 * rule: a record of who changed what is worth nothing if the runtime can edit it.
 */
export const APPEND_ONLY_TABLES = ['journal_entries', 'journal_lines', 'audit_log'] as const;

export type AppendOnlyTable = (typeof APPEND_ONLY_TABLES)[number];

export type TablePrivileges = {
  present: boolean;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
};

export type JournalPrivileges = {
  role: string;
  tables: Record<AppendOnlyTable, TablePrivileges>;
  /** Number of tables in `public` the role owns. Zero for the runtime role. */
  ownedTables: number;
};

export async function runtimeRolePrivileges(sql: Sql): Promise<JournalPrivileges> {
  const [who] = await sql<Array<{ role: string }>>`select current_user::text as role`;
  const rows = await sql<Array<{ table: AppendOnlyTable } & TablePrivileges>>`
    select t as "table",
      to_regclass('public.' || t) is not null as present,
      coalesce(has_table_privilege(current_user, to_regclass('public.' || t), 'SELECT'), false) as "select",
      coalesce(has_table_privilege(current_user, to_regclass('public.' || t), 'INSERT'), false) as "insert",
      coalesce(has_table_privilege(current_user, to_regclass('public.' || t), 'UPDATE'), false) as "update",
      coalesce(has_table_privilege(current_user, to_regclass('public.' || t), 'DELETE'), false) as "delete",
      coalesce(has_table_privilege(current_user, to_regclass('public.' || t), 'TRUNCATE'), false) as "truncate"
    from unnest(${sql.array([...APPEND_ONLY_TABLES])}::text[]) as t
  `;
  const [owned] = await sql<Array<{ count: number }>>`
    select count(*)::int as count from pg_tables where schemaname = 'public' and tableowner = current_user
  `;

  const absent: TablePrivileges = { present: false, select: false, insert: false, update: false, delete: false, truncate: false };
  const tables: Record<AppendOnlyTable, TablePrivileges> = { journal_entries: absent, journal_lines: absent, audit_log: absent };
  for (const { table, ...privileges } of rows) tables[table] = privileges;
  return { role: who?.role ?? 'unknown', tables, ownedTables: owned?.count ?? 0 };
}

export class RuntimeRoleError extends Error {
  override readonly name = 'RuntimeRoleError';
}

/** Throw unless the connected role can read and append the journal and the audit log and do nothing else to them. */
export async function assertRuntimeRole(sql: Sql): Promise<JournalPrivileges> {
  const privileges = await runtimeRolePrivileges(sql);
  const problems: string[] = [];
  for (const table of APPEND_ONLY_TABLES) {
    const p = privileges.tables[table];
    if (!p.present) problems.push(`${table} does not exist (run pnpm db:migrate)`);
    else if (!p.select || !p.insert) problems.push(`${table}: missing SELECT or INSERT (run pnpm db:migrate as purse_migrator)`);
    if (p.update || p.delete || p.truncate) problems.push(`${table}: role holds UPDATE, DELETE or TRUNCATE`);
  }
  if (privileges.ownedTables > 0) problems.push(`role owns ${privileges.ownedTables} table(s); the runtime must not be the migrator`);
  if (problems.length > 0) {
    throw new RuntimeRoleError(`Refusing to serve as ${privileges.role}: ${problems.join('; ')}`);
  }
  return privileges;
}
