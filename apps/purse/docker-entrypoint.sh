#!/bin/sh
# The Purse API container's start command (apps/purse/Dockerfile CMD; docs/deploy.md).
# Migrations first, forward-only, as `purse_migrator`: `dist/migrate.js` exits non-zero on
# any failure, and `set -e` makes that the container's exit status, so a deploy whose
# migration fails never starts a server on a half-migrated schema (spec section 10).
# The server is then started without the owner's connection string in its environment:
# the API serves as `purse_app` only, and `src/ledger/role-check.ts` refuses to boot on a
# role that could rewrite the journal.
set -eu
cd /app/apps/purse
node dist/migrate.js
unset PURSE_MIGRATOR_DATABASE_URL
exec node dist/index.js
