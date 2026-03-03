FROM node:20-slim

WORKDIR /app

# Install dependencies for better-sqlite3 native compilation and Docker CLI
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
    gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# AUTH_MODE is a compile-time setting for the frontend.
# Build with: docker build --build-arg AUTH_MODE=true .
ARG AUTH_MODE=false
ENV AUTH_MODE=${AUTH_MODE}

# Build the application
RUN npm run build

EXPOSE 47891

ENV NODE_ENV=production

# Set umask 000 so all files/dirs created by the (root) app process are
# world-readable/writable. This allows the agent container's non-root
# "claude" user (UID 1000) to access bind-mounted workspace directories.
# Files with explicit modes (e.g. secrets with 0o600) are unaffected.
CMD ["sh", "-c", "umask 000 && exec node dist/web/server.mjs"]
