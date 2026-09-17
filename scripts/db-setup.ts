import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import postgres from 'postgres';

/**
 * Provision the two databases against any reachable Postgres, the same way
 * `docker/postgres/init/01-create-databases.sh` does inside the compose container:
 *
 *   roles      purse_app, sideout_app            (LOGIN, no superuser, no CREATEDB)
 *   databases  purse, purse_test                 owned by purse_app
 *              sideout, sideout_test             owned by sideout_app
 *
 * Each role can connect only to its own databases; CONNECT is revoked from PUBLIC. Phase 1
 * additionally revokes UPDATE and DELETE on the journal tables from purse_app, which is why
 * the role split exists from day one.
 *
 * Idempotent: rerunning changes nothing that already exists (passwords are not reset).
 *
 *   pnpm db:setup                                 # admin URL from DATABASE_ADMIN_URL or local default
 *   pnpm db:setup --admin-url postgres://postgres:postgres@localhost:5432/postgres
 *   pnpm db:setup --no-write-env                  # do not create apps/{purse,sideout}/.env
 */

const { values: args } = parseArgs({
  options: {
    'admin-url': { type: 'string' },
    'purse-password': { type: 'string' },
    'sideout-password': { type: 'string' },
    'write-env': { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowNegative: true,
});

if (args.help) {
  console.log(`Usage: pnpm db:setup [--admin-url <url>] [--purse-password <pw>] [--sideout-password <pw>] [--no-write-env]

Environment: DATABASE_ADMIN_URL, PURSE_DB_PASSWORD, SIDEOUT_DB_PASSWORD`);
  process.exit(0);
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const adminUrl = args['admin-url'] ?? process.env['DATABASE_ADMIN_URL'] ?? 'postgres://localhost:5432/postgres';

type Tenant = { role: string; password: string; databases: string[]; app: string; envVar: string };

const tenants: Tenant[] = [
  {
    role: 'purse_app',
    password: args['purse-password'] ?? process.env['PURSE_DB_PASSWORD'] ?? 'purse_app',
    databases: ['purse', 'purse_test'],
    app: 'purse',
    envVar: 'PURSE_DATABASE_URL',
  },
  {
    role: 'sideout_app',
    password: args['sideout-password'] ?? process.env['SIDEOUT_DB_PASSWORD'] ?? 'sideout_app',
    databases: ['sideout', 'sideout_test'],
    app: 'sideout',
    envVar: 'SIDEOUT_DATABASE_URL',
  },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
for (const tenant of tenants) {
  for (const name of [tenant.role, ...tenant.databases]) {
    if (!IDENT.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  }
}

const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });

try {
  const [server] = await sql<Array<{ version: string }>>`select version()`;
  const version = server?.version ?? 'unknown server';
  console.log(`connected: ${version.split(',')[0] ?? version}`);

  for (const tenant of tenants) {
    await ensureRole(tenant.role, tenant.password);
    for (const database of tenant.databases) {
      await ensureDatabase(database, tenant.role);
    }
  }

  const admin = new URL(adminUrl);
  for (const tenant of tenants) {
    const urlFor = (database: string) => {
      const url = new URL(admin.toString());
      url.username = tenant.role;
      url.password = tenant.password;
      url.pathname = `/${database}`;
      url.search = '';
      return url.toString();
    };
    const [main, test] = tenant.databases as [string, string];
    console.log(`\n${tenant.envVar}=${redact(urlFor(main))}`);
    console.log(`${tenant.envVar}_TEST=${redact(urlFor(test))}`);

    if (args['write-env']) {
      const envPath = path.join(REPO_ROOT, 'apps', tenant.app, '.env');
      if (existsSync(envPath)) {
        console.log(`kept existing ${path.relative(REPO_ROOT, envPath)}`);
      } else {
        const lines = [
          `# Written by pnpm db:setup. See .env.example for every variable.`,
          `${tenant.envVar}=${urlFor(main)}`,
          `${tenant.envVar}_TEST=${urlFor(test)}`,
          '',
        ];
        await writeFile(envPath, lines.join('\n'), { mode: 0o600 });
        console.log(`wrote ${path.relative(REPO_ROOT, envPath)}`);
      }
    }
  }
  console.log('\ndone. next: pnpm db:migrate');
} finally {
  await sql.end({ timeout: 5 });
}

async function ensureRole(role: string, password: string): Promise<void> {
  const [existing] = await sql`select 1 from pg_roles where rolname = ${role}`;
  if (existing) {
    console.log(`role ${role}: exists`);
    return;
  }
  // Identifiers are validated above; the password is a literal parameter.
  await sql.unsafe(`create role ${role} login password '${password.replaceAll("'", "''")}' nosuperuser nocreatedb nocreaterole noinherit`);
  console.log(`role ${role}: created`);
}

async function ensureDatabase(database: string, owner: string): Promise<void> {
  const [existing] = await sql`select 1 from pg_database where datname = ${database}`;
  if (existing) {
    console.log(`database ${database}: exists`);
  } else {
    await sql.unsafe(`create database ${database} owner ${owner} encoding 'UTF8' template template0`);
    console.log(`database ${database}: created, owner ${owner}`);
  }
  // Only the owning role may connect; nobody else, including the other app's role.
  await sql.unsafe(`revoke connect on database ${database} from public`);
  await sql.unsafe(`grant connect on database ${database} to ${owner}`);
}

function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}
