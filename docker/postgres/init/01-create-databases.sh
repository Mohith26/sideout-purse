#!/usr/bin/env bash
# Runs once, on first start of the compose Postgres container, as the superuser.
# Mirrors scripts/db-setup.ts: three roles, four databases, each role confined to its own.
# Keep the two in step; the TypeScript version is the one CI and non-Docker setups use, and
# it is also what upgrades a volume created before purse_migrator existed (init scripts do
# not re-run): `pnpm db:setup --admin-url postgres://postgres:postgres@localhost:5432/postgres`.
set -euo pipefail

: "${PURSE_DB_PASSWORD:?PURSE_DB_PASSWORD is required}"
: "${PURSE_MIGRATOR_DB_PASSWORD:?PURSE_MIGRATOR_DB_PASSWORD is required}"
: "${SIDEOUT_DB_PASSWORD:?SIDEOUT_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v purse_password="$PURSE_DB_PASSWORD" \
  -v purse_migrator_password="$PURSE_MIGRATOR_DB_PASSWORD" \
  -v sideout_password="$SIDEOUT_DB_PASSWORD" <<'SQL'
-- Roles: login only, no superuser, no createdb, no createrole.
--
-- Purse has two. purse_migrator owns its databases and every table and is the only role
-- that runs migrations and seeds. purse_app is the runtime role: it owns nothing, so it
-- cannot grant itself anything, and migrations 0002_ledger_roles and 0004_ledger_guards
-- give it exactly what the API needs, which excludes UPDATE and DELETE on the journal
-- (spec 4.2.2 rule 5). An owner can always re-grant what was revoked, which is why the
-- runtime is not the owner.
create role purse_migrator login password :'purse_migrator_password' nosuperuser nocreatedb nocreaterole noinherit;
create role purse_app      login password :'purse_password'          nosuperuser nocreatedb nocreaterole noinherit;
create role sideout_app    login password :'sideout_password'        nosuperuser nocreatedb nocreaterole noinherit;

create database purse        owner purse_migrator encoding 'UTF8' template template0;
create database purse_test   owner purse_migrator encoding 'UTF8' template template0;
create database sideout      owner sideout_app    encoding 'UTF8' template template0;
create database sideout_test owner sideout_app    encoding 'UTF8' template template0;

-- Only the named roles may connect. Neither app can reach the other's database.
revoke connect on database purse,   purse_test   from public;
revoke connect on database sideout, sideout_test from public;
grant  connect on database purse,   purse_test   to purse_migrator, purse_app;
grant  connect on database sideout, sideout_test to sideout_app;
SQL
