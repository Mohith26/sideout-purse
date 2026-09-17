#!/usr/bin/env bash
# Runs once, on first start of the compose Postgres container, as the superuser.
# Mirrors scripts/db-setup.ts: two roles, four databases, each role confined to its own.
# Keep the two in step; the TypeScript version is the one CI and non-Docker setups use.
set -euo pipefail

: "${PURSE_DB_PASSWORD:?PURSE_DB_PASSWORD is required}"
: "${SIDEOUT_DB_PASSWORD:?SIDEOUT_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v purse_password="$PURSE_DB_PASSWORD" \
  -v sideout_password="$SIDEOUT_DB_PASSWORD" <<'SQL'
-- Roles: login only, no superuser, no createdb. Phase 1 revokes UPDATE/DELETE on the
-- journal tables from purse_app; that is why the app never connects as the superuser.
create role purse_app   login password :'purse_password'   nosuperuser nocreatedb nocreaterole noinherit;
create role sideout_app login password :'sideout_password' nosuperuser nocreatedb nocreaterole noinherit;

create database purse        owner purse_app   encoding 'UTF8' template template0;
create database purse_test   owner purse_app   encoding 'UTF8' template template0;
create database sideout      owner sideout_app encoding 'UTF8' template template0;
create database sideout_test owner sideout_app encoding 'UTF8' template template0;

-- Only the owning role may connect. Neither app can reach the other's database.
revoke connect on database purse,   purse_test   from public;
revoke connect on database sideout, sideout_test from public;
grant  connect on database purse,   purse_test   to purse_app;
grant  connect on database sideout, sideout_test to sideout_app;
SQL
