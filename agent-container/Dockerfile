FROM ubuntu:22.04

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    ca-certificates \
    gnupg \
    # Network/DNS utilities
    dnsutils \
    iputils-ping \
    net-tools \
    iproute2 \
    traceroute \
    netcat-openbsd \
    whois \
    # Common tools
    jq \
    less \
    vim-tiny \
    zip \
    unzip \
    file \
    tree \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Python 3.11 and pip
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3-pip \
    python3.11-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python

# Install UV (Universal Virtualenv)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@2.1.47

# Install TypeScript and ts-node globally
RUN npm install -g typescript ts-node

# Install Bun (for running dashboard servers)
# Install as root then copy binary to /usr/local/bin so the claude user can access it
# (symlinks to /root/.bun/bin/ won't work because /root/ is not readable by other users)
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx && \
    chmod 755 /usr/local/bin/bun

# Install Chromium dependencies (needed by Playwright/agent-browser)
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
    libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser and download Chromium
# Set PLAYWRIGHT_BROWSERS_PATH so browsers are installed to a shared location
# accessible by both root (build) and claude (runtime) users
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npm install -g agent-browser && \
    npx playwright install chromium && \
    chmod -R o+rx /opt/playwright-browsers

# Create workspace directory
RUN mkdir -p /workspace
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Create non-root user for running Claude Code
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app /workspace

# Copy skills into the user's Claude config directory (after user creation)
COPY skills/ /home/claude/.claude/skills/
RUN chown -R claude:claude /home/claude/.claude

# Switch to non-root user
USER claude

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/home/claude
ENV AGENT_BROWSER_STREAM_PORT=9223
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-blink-features=AutomationControlled,--disable-features=AutomationControlled,--disable-infobars,--disable-background-timer-throttling,--disable-popup-blocking,--disable-backgrounding-occluded-windows,--disable-renderer-backgrounding,--disable-component-update"
ENV AGENT_BROWSER_USER_AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
ENV AGENT_BROWSER_PROFILE=/workspace/.browser-profile

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "dist/server.js"]
