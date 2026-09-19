# syntax=docker/dockerfile:1
#
# Ping-pong image (the second tenant; docs/second-tenant.md, docs/deploy.md): the Next.js
# production build, served by `next start`, plus the bundled operational scripts (migrate,
# seed, reset). Built from the repository root (`docker build -f apps/pingpong/Dockerfile .`),
# because the workspace is one pnpm install. Three stages, the same shape as Sideout's:
#
#   build    installs the app's workspace subset with dev dependencies and runs
#            `pnpm build` (`next build`, the `sk_` bundle check, then tsup for `dist/`)
#   deps     a clean install of the same subset with production dependencies only
#   runtime  Node 22, those node_modules, `.next/`, `dist/` and the migrations, running as
#            the unprivileged `node` user
#
# Build arguments Railway passes through from service variables of the same name. The
# `NEXT_PUBLIC_*` values are inlined into the browser bundle by `next build`, so they must
# be present here as well as at runtime:
#   BUILD_SHA                            the deployed commit, reported by /health
#   NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY    what the SDK mounts flows with
#   NEXT_PUBLIC_PURSE_ORIGIN             where the iframe is served from
#   NEXT_PUBLIC_PURSE_TENANT_ID          the ping-pong tenant on Purse
#
# The start command (CMD, `docker-entrypoint.sh`) runs the migrations and fails the deploy
# on an error, then starts the server.

FROM node:22-bookworm-slim AS base
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter "@pingpong/web..."
ARG BUILD_SHA
ARG NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_PURSE_ORIGIN
ARG NEXT_PUBLIC_PURSE_TENANT_ID
ENV NODE_ENV=production \
    BUILD_SHA=${BUILD_SHA:-unknown} \
    NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY=${NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY} \
    NEXT_PUBLIC_PURSE_ORIGIN=${NEXT_PUBLIC_PURSE_ORIGIN} \
    NEXT_PUBLIC_PURSE_TENANT_ID=${NEXT_PUBLIC_PURSE_TENANT_ID}
# `.next/cache` is build-only and is not copied into the image.
RUN pnpm --filter @pingpong/web build && rm -rf apps/pingpong/.next/cache

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "@pingpong/web..." --filter "!@repo/config"

FROM base AS runtime
ARG BUILD_SHA
ENV NODE_ENV=production \
    PORT=3100 \
    BUILD_SHA=${BUILD_SHA:-unknown}
COPY --from=deps --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages ./packages
COPY --from=deps --chown=node:node /app/apps/pingpong/package.json ./apps/pingpong/package.json
COPY --from=deps --chown=node:node /app/apps/pingpong/node_modules ./apps/pingpong/node_modules
COPY --from=build --chown=node:node /app/apps/pingpong/dist/next.config.js ./apps/pingpong/next.config.js
COPY --from=build --chown=node:node /app/apps/pingpong/.next ./apps/pingpong/.next
COPY --from=build --chown=node:node /app/apps/pingpong/dist ./apps/pingpong/dist
COPY --from=build --chown=node:node /app/apps/pingpong/drizzle ./apps/pingpong/drizzle
COPY --chmod=755 apps/pingpong/docker-entrypoint.sh /usr/local/bin/pingpong-entrypoint
USER node
WORKDIR /app/apps/pingpong
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3100) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["pingpong-entrypoint"]
