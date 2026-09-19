#!/bin/sh
# The nightly demo reset (docker/demo-reset/Dockerfile CMD; docs/deploy.md, "Nightly demo
# reset"). Purse first: every demo row deleted as `purse_migrator`, the seed applied on the
# empty tables. Then Sideout: every table emptied, the seed written and mirrored to the
# fresh Purse through the API. Either half failing fails the run (`set -e`), and a
# failed run is what the host's cron log shows. Each half reads only its own database's
# connection string (`apps/*/src/env.ts`); this shell holds both for the duration of the
# job and nothing else.
set -eu
: "${DEMO_RESET:?DEMO_RESET=allow must be set for the reset to run}"
echo '{"service":"demo-reset","msg":"resetting Purse"}'
(cd /app/apps/purse && node dist/demo-reset.js)
echo '{"service":"demo-reset","msg":"resetting Sideout"}'
(cd /app/apps/sideout && node dist/demo-reset.js)
echo '{"service":"demo-reset","msg":"demo reset complete"}'
