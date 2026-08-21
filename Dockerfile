# ---- builder: full install + web/server build ----
FROM node:22-slim AS builder

WORKDIR /app

# Toolchain for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# AUTH_MODE is a compile-time setting for the frontend.
# Build with: docker build --build-arg AUTH_MODE=true .
ARG AUTH_MODE=false
ENV AUTH_MODE=${AUTH_MODE}

RUN npm run build

# ---- deps: production-only node_modules ----
FROM node:22-slim AS deps

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime

WORKDIR /app

# git is used at runtime by the skillset GitHub provider.
# The Docker CLI is needed for DooD (self-hosted docker-compose); hosted
# deployments that run agents via MicroVMs can build with
# --build-arg INCLUDE_DOCKER_CLI=false to drop it.
ARG INCLUDE_DOCKER_CLI=true
RUN apt-get update && apt-get install -y git ca-certificates \
    && if [ "$INCLUDE_DOCKER_CLI" = "true" ]; then \
        apt-get install -y curl gnupg \
        && install -m 0755 -d /etc/apt/keyrings \
        && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
        && chmod a+r /etc/apt/keyrings/docker.gpg \
        && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
        && apt-get update \
        && apt-get install -y docker-ce-cli \
        && apt-get purge -y curl gnupg \
        && apt-get autoremove -y; \
    fi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
# Drizzle migrations are read from cwd at startup (src/shared/lib/db/index.ts)
COPY src/shared/lib/db/migrations ./src/shared/lib/db/migrations
# Agent container build context for buildImage() when running DooD without the
# compose bind-mount (docker-compose mounts ./agent-container over this)
COPY agent-container ./agent-container

ARG AUTH_MODE=false
ENV AUTH_MODE=${AUTH_MODE}

EXPOSE 47891

ENV NODE_ENV=production
ENV NODE_COMPILE_CACHE=/app/.compile-cache
COPY scripts/warmup-compile-cache.sh /app/scripts/warmup-compile-cache.sh
RUN chmod +x /app/scripts/warmup-compile-cache.sh && /app/scripts/warmup-compile-cache.sh

# umask 000: all files/dirs are world-readable/writable so agent containers
# (running as non-root "claude" user) can access bind-mounted workspaces.
CMD ["sh", "-c", "umask 000 && exec node dist/web/server.mjs"]
