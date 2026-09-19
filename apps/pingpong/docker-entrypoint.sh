#!/bin/sh
# The ping-pong container's start command (apps/pingpong/Dockerfile CMD; docs/second-tenant.md).
# Migrations first, forward-only: `dist/migrate.js` exits non-zero on any failure, and
# `set -e` makes that the container's exit status, so a deploy whose migration fails never
# starts a server on a half-migrated schema (spec section 10). Then `next start` on the
# port the host assigns.
set -eu
cd /app/apps/pingpong
node dist/migrate.js
exec node node_modules/next/dist/bin/next start --port "${PORT:-3100}"
