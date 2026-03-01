FROM node:20-slim

WORKDIR /app

# Install dependencies for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
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

CMD ["node", "dist/web/server.mjs"]
