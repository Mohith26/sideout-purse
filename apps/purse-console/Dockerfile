# syntax=docker/dockerfile:1
#
# Purse operator console image (spec 4.10, section 10; docs/deploy.md): the Next.js
# production build served by `next start` on its own origin, talking to the Purse API's
# `/console/*` routes server-to-server (`PURSE_API_ORIGIN`). No database, no secret key:
# `scripts/check-bundle.ts` fails the build if the client bundle carries one. Built from
# the repository root (`docker build -f apps/purse-console/Dockerfile .`), because the
# workspace is one pnpm install. Three stages, like the other two images:
#
#   build    installs the console's workspace subset with dev dependencies and runs
#            `pnpm build` (`next build`, the bundle check, the compiled `next.config.js`)
#   deps     a clean install of the same subset with production dependencies only
#   runtime  Node 22, those node_modules and `.next/`, as the `node` user
#
# Build arguments Railway passes through from service variables of the same name:
#   BUILD_SHA   the deployed commit, reported by /health.

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
    pnpm install --frozen-lockfile --filter "@purse/console..."
ARG BUILD_SHA
ENV NODE_ENV=production \
    BUILD_SHA=${BUILD_SHA:-unknown}
RUN pnpm --filter @purse/console build && rm -rf apps/purse-console/.next/cache

FROM base AS deps
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@purse/console..." --filter "!@repo/config"

FROM base AS runtime
ARG BUILD_SHA
ENV NODE_ENV=production \
    PORT=4200 \
    BUILD_SHA=${BUILD_SHA:-unknown}
COPY --from=deps --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages ./packages
COPY --from=deps --chown=node:node /app/apps/purse-console/package.json ./apps/purse-console/package.json
COPY --from=deps --chown=node:node /app/apps/purse-console/node_modules ./apps/purse-console/node_modules
COPY --from=build --chown=node:node /app/apps/purse-console/dist/next.config.js ./apps/purse-console/next.config.js
COPY --from=build --chown=node:node /app/apps/purse-console/.next ./apps/purse-console/.next
COPY --chmod=755 apps/purse-console/docker-entrypoint.sh /usr/local/bin/console-entrypoint
USER node
WORKDIR /app/apps/purse-console
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4200) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["console-entrypoint"]
