# syntax=docker/dockerfile:1
#
# The nightly demo reset job (spec section 10; docs/deploy.md): a container that resets
# both databases to the seed and exits. It carries the bundled reset scripts of both apps
# (`apps/purse/dist/demo-reset.js`, `apps/sideout/dist/demo-reset.js`) and their
# production dependencies, and nothing that serves: no Next build, no API. Built from the
# repository root (`docker build -f docker/demo-reset/Dockerfile .`). Runs as `node`.
# `run.sh` is the command; the host's cron schedule starts it once a night.

FROM node:22-bookworm-slim AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@purse/api..." --filter "@sideout/web..."
ENV NODE_ENV=production
RUN pnpm --filter @purse/api build && pnpm --filter @sideout/web exec tsup

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "@purse/api..." --filter "@sideout/web..." --filter "!@repo/config"

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages ./packages
COPY --from=deps --chown=node:node /app/apps/purse/package.json ./apps/purse/package.json
COPY --from=deps --chown=node:node /app/apps/purse/node_modules ./apps/purse/node_modules
COPY --from=deps --chown=node:node /app/apps/sideout/package.json ./apps/sideout/package.json
COPY --from=deps --chown=node:node /app/apps/sideout/node_modules ./apps/sideout/node_modules
COPY --from=build --chown=node:node /app/apps/purse/dist ./apps/purse/dist
COPY --from=build --chown=node:node /app/apps/purse/drizzle ./apps/purse/drizzle
COPY --from=build --chown=node:node /app/apps/sideout/dist ./apps/sideout/dist
COPY --from=build --chown=node:node /app/apps/sideout/drizzle ./apps/sideout/drizzle
COPY --chmod=755 docker/demo-reset/run.sh /usr/local/bin/demo-reset
USER node
CMD ["demo-reset"]
