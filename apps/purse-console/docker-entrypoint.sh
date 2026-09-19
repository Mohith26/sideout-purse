#!/bin/sh
# The console container's start command (apps/purse-console/Dockerfile CMD). The console
# owns no database, so there is nothing to migrate: `next start` on the port the host
# assigns.
set -eu
cd /app/apps/purse-console
exec node node_modules/next/dist/bin/next start --port "${PORT:-4200}"
