# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# deps — install once, cached on the lockfile
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for common platforms but falls back to
# compiling, so the toolchain has to be here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# build — compile the Next.js standalone bundle
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# The build imports modules that read env.ts at load time; a throwaway value is
# enough to satisfy it and never reaches the running container.
ENV APP_SECRET=build-time-placeholder-not-used-at-runtime
# Collecting page data opens the database. Point it at a scratch path so no
# stray app.db is baked into the image layer.
ENV DATA_DIR=/tmp/build-scratch
RUN npm run build

# ---------------------------------------------------------------------------
# runtime — slim image with ffmpeg for audio compression
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    DATABASE_PATH=/data/app.db \
    RECORDINGS_DIR=/data/recordings

# `output: 'standalone'` emits a self-contained server with only the modules it
# actually imports, which keeps the runtime image small.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# The standalone trace misses better-sqlite3's native .node file, so the real
# module directory is copied over the traced stub.
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /app/node_modules/bindings ./node_modules/bindings
COPY --from=build /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

RUN mkdir -p /data/recordings && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
