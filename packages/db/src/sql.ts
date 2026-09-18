import postgres from 'postgres';

export type Sql = postgres.Sql;

export type CreateSqlOptions = {
  /** Upper bound on pooled connections. Migrators and scripts should pass 1. */
  max?: number;
  /** Shown in `pg_stat_activity.application_name`, so a connection can be traced to a service. */
  applicationName: string;
};

/**
 * Open a postgres.js pool for one connection string.
 *
 * The caller passes the URL explicitly; this module never reads `process.env`, which is
 * what keeps each app's env module the only place its connection string is known.
 */
export function createSql(url: string, options: CreateSqlOptions): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: options.applicationName },
    // Notices (e.g. "relation already exists, skipping") are not errors and would
    // otherwise be written straight to stderr outside the structured log stream.
    onnotice: () => undefined,
  });
}

/** Close a pool, waiting briefly for in-flight queries. */
export async function closeSql(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}
