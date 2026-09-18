# syntax=docker/dockerfile:1
#
# Sideout image (spec section 10; docs/deploy.md): the Next.js production build, served
# by `next start`, plus the bundled operational scripts (migrate, seed, demo-reset). Built
# from the repository root (`docker build -f apps/sideout/Dockerfile .`), because the
# workspace is one pnpm install. Three stages:
#
#   build    installs Sideout's workspace subset with dev dependencies and runs
#            `pnpm build` (`next build`, the `sk_` bundle check, then tsup for `dist/`:
#            the scripts and the compiled `next.config.js` the server starts with)
#   deps     a clean install of the same subset with production dependencies only
#   runtime  Node 22, those node_modules, `.next/`, `public/`, `dist/` and the migrations,
#            running as the unprivileged `node` user
#
# Build arguments Railway passes through from service variables of the same name. The
# `NEXT_PUBLIC_*` values are inlined into the browser bundle by `next build`, so they must
# be present here as well as at runtime (Railway hands the same variables to both):
#   BUILD_SHA                            the deployed commit: /health, and the service
#                                        worker's cache version (a new build must carry a
#                                        new sha or phones keep the previous pages)
#   NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY    what the SDK mounts flows with
#   NEXT_PUBLIC_PURSE_ORIGIN             where the iframe is served from
#   NEXT_PUBLIC_PURSE_TENANT_ID          the Sideout tenant on Purse
#   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY   optional: the Payment Element's key
#
# The start command (CMD, `docker-entrypoint.sh`) runs the migrations and fails the deploy
# on an error, then starts the server.

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
    pnpm install --frozen-lockfile --filter "@sideout/web..."
ARG BUILD_SHA
ARG NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_PURSE_ORIGIN
ARG NEXT_PUBLIC_PURSE_TENANT_ID
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ENV NODE_ENV=production \
    BUILD_SHA=${BUILD_SHA:-unknown} \
    NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY=${NEXT_PUBLIC_PURSE_PUBLISHABLE_KEY} \
    NEXT_PUBLIC_PURSE_ORIGIN=${NEXT_PUBLIC_PURSE_ORIGIN} \
    NEXT_PUBLIC_PURSE_TENANT_ID=${NEXT_PUBLIC_PURSE_TENANT_ID} \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}
# `.next/cache` is build-only and is not copied into the image.
RUN pnpm --filter @sideout/web build && rm -rf apps/sideout/.next/cache

FROM base AS deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@sideout/web..." --filter "!@repo/config"

FROM base AS runtime
ARG BUILD_SHA
ENV NODE_ENV=production \
    PORT=3000 \
    BUILD_SHA=${BUILD_SHA:-unknown}
COPY --from=deps --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages ./packages
COPY --from=deps --chown=node:node /app/apps/sideout/package.json ./apps/sideout/package.json
COPY --from=deps --chown=node:node /app/apps/sideout/node_modules ./apps/sideout/node_modules
COPY --from=build --chown=node:node /app/apps/sideout/dist/next.config.js ./apps/sideout/next.config.js
COPY --from=build --chown=node:node /app/apps/sideout/.next ./apps/sideout/.next
COPY --from=build --chown=node:node /app/apps/sideout/public ./apps/sideout/public
COPY --from=build --chown=node:node /app/apps/sideout/dist ./apps/sideout/dist
COPY --from=build --chown=node:node /app/apps/sideout/drizzle ./apps/sideout/drizzle
COPY --chmod=755 apps/sideout/docker-entrypoint.sh /usr/local/bin/sideout-entrypoint
USER node
WORKDIR /app/apps/sideout
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["sideout-entrypoint"]
