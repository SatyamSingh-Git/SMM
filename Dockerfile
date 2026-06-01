# Production image: API + worker in a single Node process (apps/api/src/prod.ts).
# pnpm workspace-aware. Uses tsx in production for simplicity — no compile step.

# node:20-slim (Debian-based) instead of alpine -- Prisma's query engine
# needs libssl/OpenSSL, which musl/alpine ships oddly. Slim image is ~50MB
# larger but every Prisma binary just works.
FROM node:20-slim

# pnpm via corepack (shipped with Node 20). Add OpenSSL + curl explicitly
# even on slim (some Prisma versions still probe for it).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# 1. Lockfile + workspace manifests (cached unless any package.json changes)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY tsconfig.base.json ./

RUN pnpm install --frozen-lockfile

# 2. Source
COPY apps/api ./apps/api
COPY packages/db ./packages/db

# 3. Generate Prisma client (needs schema + node_modules)
RUN pnpm --filter @smm/db generate

# 4. Bundle the API + workspace deps into a single file via esbuild. This is
#    what fits us into the free 256MB tier -- no tsx transpile overhead, no
#    workspace symlink walking at startup.
RUN pnpm --filter @smm/api bundle

# 5. Volume mount point for uploaded media. Fly mounts /data to a persistent
#    volume; UPLOAD_DIR env var tells our storage layer to write here.
RUN mkdir -p /data/uploads

ENV NODE_ENV=production
ENV API_PORT=8080
ENV UPLOAD_DIR=/data/uploads
# Cap V8 heap so Node doesn't grow into the OS reserve and trigger an OOM kill.
# 256MB machine - reserve ~80MB for non-heap (Buffer pools, native bindings, RSS).
ENV NODE_OPTIONS=--max-old-space-size=180

EXPOSE 8080

# fly.toml's [processes] block can override this; left as a sensible default.
CMD ["pnpm", "--filter", "@smm/api", "start:prod"]
