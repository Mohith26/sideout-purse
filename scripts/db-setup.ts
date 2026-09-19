import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import postgres from 'postgres';

/**
 * Provision the databases against any reachable Postgres, the same way
 * `docker/postgres/init/01-create-databases.sh` does inside the compose container:
 *
 *   roles      purse_migrator                     owner of the Purse databases and every
 *                                                 table in them; runs db:migrate and db:seed
 *              purse_app                          Purse's runtime role: owns nothing, can
 *                                                 grant nothing, holds only what migrations
 *                                                 0002_ledger_roles and 0004_ledger_guards
 *                                                 grant it (no UPDATE or DELETE on the
 *                                                 journal, spec 4.2.2 rule 5)
 *              sideout_app                        Sideout's single role (owner and runtime)
 *              pingpong_app                       the ping-pong ladder's single role (the second
 *                                                 tenant, docs/second-tenant.md)
 *   databases  purse, purse_test                  owned by purse_migrator; purse_app may connect
 *              sideout, sideout_test              owned by sideout_app
 *              pingpong, pingpong_test            owned by pingpong_app
 *
 * CONNECT is revoked from PUBLIC on every database, so each role reaches only its own.
 * Every role is LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT.
 *
 * Idempotent: rerunning changes nothing that already exists (passwords are not reset).
 * The one deliberate change it makes to an existing database is ownership: a Purse
 * database still owned by purse_app from phase 0 is handed to purse_migrator, along with
 * everything inside it, so the runtime role stops being able to re-grant itself what the
 * migration revokes.
 *
 *   pnpm db:setup                                 # admin URL from DATABASE_ADMIN_URL or local default
 *   pnpm db:setup --admin-url postgres://postgres:postgres@localhost:5432/postgres
 *   pnpm db:setup --no-write-env                  # do not create apps/{purse,sideout,pingpong}/.env
 *   pnpm db:setup --no-test-databases             # a hosted Postgres: purse, sideout and pingpong only
 */

const { values: args } = parseArgs({
  options: {
    'admin-url': { type: 'string' },
    'purse-password': { type: 'string' },
    'purse-migrator-password': { type: 'string' },
    'sideout-password': { type: 'string' },
    'pingpong-password': { type: 'string' },
    'write-env': { type: 'boolean', default: true },
    'test-databases': { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowNegative: true,
});

if (args.help) {
  console.log(`Usage: pnpm db:setup [--admin-url <url>] [--purse-password <pw>] [--purse-migrator-password <pw>] [--sideout-password <pw>] [--pingpong-password <pw>] [--no-write-env] [--no-test-databases]

Environment: DATABASE_ADMIN_URL, PURSE_DB_PASSWORD, PURSE_MIGRATOR_DB_PASSWORD, SIDEOUT_DB_PASSWORD, PINGPONG_DB_PASSWORD`);
  process.exit(0);
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const adminUrl = args['admin-url'] ?? process.env['DATABASE_ADMIN_URL'] ?? 'postgres://localhost:5432/postgres';

type Role = { name: string; password: string; envVar: string };

type App = {
  app: string;
  databases: [main: string, test: string];
  /** Owns the databases and everything in them. Runs migrations and seeds. */
  owner: Role;
  /** Connects at runtime with only the privileges migrations grant it. Same as `owner` for Sideout. */
  runtime: Role;
};

/** Sideout keeps one role for both jobs; the same object fills both slots below. */
const sideoutRole: Role = {
  name: 'sideout_app',
  password: args['sideout-password'] ?? process.env['SIDEOUT_DB_PASSWORD'] ?? 'sideout_app',
  envVar: 'SIDEOUT_DATABASE_URL',
};

/** The ping-pong ladder, the second tenant: one role, like Sideout (its tables hold no ledger). */
const pingpongRole: Role = {
  name: 'pingpong_app',
  password: args['pingpong-password'] ?? process.env['PINGPONG_DB_PASSWORD'] ?? 'pingpong_app',
  envVar: 'PINGPONG_DATABASE_URL',
};

const apps: App[] = [
  {
    app: 'purse',
    databases: ['purse', 'purse_test'],
    owner: {
      name: 'purse_migrator',
      password: args['purse-migrator-password'] ?? process.env['PURSE_MIGRATOR_DB_PASSWORD'] ?? 'purse_migrator',
      envVar: 'PURSE_MIGRATOR_DATABASE_URL',
    },
    runtime: {
      name: 'purse_app',
      password: args['purse-password'] ?? process.env['PURSE_DB_PASSWORD'] ?? 'purse_app',
      envVar: 'PURSE_DATABASE_URL',
    },
  },
  { app: 'sideout', databases: ['sideout', 'sideout_test'], owner: sideoutRole, runtime: sideoutRole },
  { app: 'pingpong', databases: ['pingpong', 'pingpong_test'], owner: pingpongRole, runtime: pingpongRole },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
for (const app of apps) {
  for (const name of [app.owner.name, app.runtime.name, ...app.databases]) {
    if (!IDENT.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  }
}

const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });

try {
  const [server] = await sql<Array<{ version: string }>>`select version()`;
  const version = server?.version ?? 'unknown server';
  console.log(`connected: ${version.split(',')[0] ?? version}`);

  for (const app of apps) {
    const roles = app.runtime === app.owner ? [app.owner] : [app.owner, app.runtime];
    for (const role of roles) await ensureRole(role);
    for (const database of args['test-databases'] ? app.databases : [app.databases[0]]) {
      await ensureDatabase(database, app.owner.name, roles);
      if (app.runtime !== app.owner) await reassignStrays(database, app.runtime.name, app.owner.name);
    }
  }

  const admin = new URL(adminUrl);
  for (const app of apps) {
    const urlFor = (role: Role, database: string) => {
      const url = new URL(admin.toString());
      url.username = role.name;
      url.password = role.password;
      url.pathname = `/${database}`;
      url.search = '';
      return url.toString();
    };
    const [main, test] = app.databases;
    const roles = app.runtime === app.owner ? [app.owner] : [app.runtime, app.owner];
    const lines = roles.flatMap((role) => [`${role.envVar}=${urlFor(role, main)}`, ...(args['test-databases'] ? [`${role.envVar}_TEST=${urlFor(role, test)}`] : [])]);
    console.log('');
    for (const line of lines) console.log(redactLine(line));

    if (args['write-env']) {
      const envPath = path.join(REPO_ROOT, 'apps', app.app, '.env');
      if (existsSync(envPath)) {
        console.log(`kept existing ${path.relative(REPO_ROOT, envPath)} (check it names every variable above)`);
      } else {
        await writeFile(envPath, [`# Written by pnpm db:setup. See .env.example for every variable.`, ...lines, ''].join('\n'), {
          mode: 0o600,
        });
        console.log(`wrote ${path.relative(REPO_ROOT, envPath)}`);
      }
    }
  }
  console.log('\ndone. next: pnpm db:migrate && pnpm db:seed');
} finally {
  await sql.end({ timeout: 5 });
}

async function ensureRole(role: Role): Promise<void> {
  const [existing] = await sql`select 1 from pg_roles where rolname = ${role.name}`;
  if (existing) {
    console.log(`role ${role.name}: exists`);
    return;
  }
  // Identifiers are validated above; the password is a quoted literal.
  await sql.unsafe(
    `create role ${role.name} login password '${role.password.replaceAll("'", "''")}' nosuperuser nocreatedb nocreaterole noinherit`,
  );
  console.log(`role ${role.name}: created`);
}

async function ensureDatabase(database: string, owner: string, connectors: Role[]): Promise<void> {
  const [existing] = await sql<Array<{ owner: string }>>`
    select pg_get_userbyid(datdba) as owner from pg_database where datname = ${database}
  `;
  if (existing === undefined) {
    await sql.unsafe(`create database ${database} owner ${owner} encoding 'UTF8' template template0`);
    console.log(`database ${database}: created, owner ${owner}`);
  } else if (existing.owner === owner) {
    console.log(`database ${database}: exists`);
  } else {
    // The phase 0 -> phase 1 transition for a Purse database still owned by purse_app.
    // Refused for an owner this script does not know, because taking a stranger's
    // database is not something a setup script should do quietly.
    const known = apps.flatMap((app) => [app.owner.name, app.runtime.name]);
    if (!known.includes(existing.owner)) {
      throw new Error(`database ${database} is owned by ${existing.owner}, not ${owner}; reassign it by hand before running db:setup`);
    }
    await sql.unsafe(`alter database ${database} owner to ${owner}`);
    console.log(`database ${database}: owner changed ${existing.owner} -> ${owner}`);
  }
  // Only the named roles may connect; nobody else, including the other app's role.
  await sql.unsafe(`revoke connect on database ${database} from public`);
  for (const role of connectors) {
    await sql.unsafe(`grant connect on database ${database} to ${role.name}`);
  }
}

/**
 * Inside a database, hand every schema and relation the runtime role still owns to the
 * owner role. Ownership is what lets a role re-grant itself what a migration revoked, so
 * the runtime must own nothing; this catches tables from before the split and a `public`
 * schema recreated by an old test reset. A no-op once the database is clean.
 */
async function reassignStrays(database: string, from: string, to: string): Promise<void> {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const inDatabase = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    const [stray] = await inDatabase<Array<{ count: number }>>`
      select (
        (select count(*) from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = ${from})
        + (select count(*) from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = ${from})
      )::int as count
    `;
    if (stray === undefined || stray.count === 0) return;
    await inDatabase.unsafe(`reassign owned by ${from} to ${to}`);
    console.log(`database ${database}: ${stray.count} object(s) owned by ${from} reassigned to ${to}`);
  } finally {
    await inDatabase.end({ timeout: 5 });
  }
}

function redactLine(line: string): string {
  const [name, value] = line.split('=', 2);
  if (name === undefined || value === undefined) return line;
  const u = new URL(value);
  if (u.password) u.password = '***';
  return `${name}=${u.toString()}`;
}
