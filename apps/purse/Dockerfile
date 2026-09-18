# syntax=docker/dockerfile:1
#
# Purse API image (spec section 10; docs/deploy.md): the API, the contest engine, the
# ledger, the webhook dispatcher and the embed app it serves under /embed, in one
# container. Built from the repository root (`docker build -f apps/purse/Dockerfile .`),
# because the workspace is one pnpm install. Three stages:
#
#   build    installs the API's and the embed's workspace subsets with dev dependencies,
#            builds the SDK bundle, the embed's static export and the API's `dist/`
#            (tsup inlines the workspace packages; `dist/` is the service plus its
#            operational scripts: migrate, seed, reconcile, purge, demo-reset)
#   deps     a clean install of the API's subset with production dependencies only
#   runtime  Node 22, those node_modules, `dist/`, the migrations and the embed export,
#            running as the unprivileged `node` user
#
# Build arguments Railway passes through from service variables of the same name:
#   BUILD_SHA   the deployed commit, reported by /health (`railway up` uploads the working
#               tree without .git, so it must be set explicitly).
#
# The start command (CMD, `docker-entrypoint.sh`) runs the migrations as the owner role
# and fails the deploy on an error, then serves as the runtime role only.

FROM node:22-bookworm-slim AS base
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm
RUN corepack enable && pnpm config set store-dir /pnpm/store
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@purse/api..." --filter "@purse/embed..."
ARG BUILD_SHA
ENV NODE_ENV=production \
    BUILD_SHA=${BUILD_SHA:-unknown}
RUN pnpm --filter @purse/sdk build \
  && pnpm --filter @purse/embed build \
  && pnpm --filter @purse/api build

FROM base AS deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@purse/api..." --filter "!@repo/config"

FROM base AS runtime
ARG BUILD_SHA
ENV NODE_ENV=production \
    PORT=4000 \
    BUILD_SHA=${BUILD_SHA:-unknown}
COPY --from=deps --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages ./packages
COPY --from=deps --chown=node:node /app/apps/purse/package.json ./apps/purse/package.json
COPY --from=deps --chown=node:node /app/apps/purse/node_modules ./apps/purse/node_modules
COPY --from=build --chown=node:node /app/apps/purse/dist ./apps/purse/dist
COPY --from=build --chown=node:node /app/apps/purse/drizzle ./apps/purse/drizzle
COPY --from=build --chown=node:node /app/apps/purse-embed/out ./apps/purse-embed/out
COPY --chmod=755 apps/purse/docker-entrypoint.sh /usr/local/bin/purse-entrypoint
USER node
WORKDIR /app/apps/purse
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["purse-entrypoint"]
