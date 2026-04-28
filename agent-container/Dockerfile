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
    # Timezone data (required for TZ env var to resolve IANA names)
    tzdata \
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

# Install Claude Code CLI (native binary, pinned version)
RUN curl -fsSL https://claude.ai/install.sh | bash -s 2.1.111 && \
    cp /root/.local/bin/claude /usr/local/bin/claude && \
    chmod 755 /usr/local/bin/claude

# Install TypeScript and ts-node globally
RUN npm install -g typescript ts-node

# Install Bun (for running dashboard servers)
# Install as root then copy binary to /usr/local/bin so the claude user can access it
# (symlinks to /root/.bun/bin/ won't work because /root/ is not readable by other users)
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx && \
    chmod 755 /usr/local/bin/bun

# Install Chromium dependencies (needed by agent-browser)
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
    libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser (native Rust binary since v0.20.0) and Playwright's
# Chromium. Both the agent-browser runtime (via find_playwright_chromium) and
# our dashboard screenshot code (via playwright-core) share a single Chromium
# install under PLAYWRIGHT_BROWSERS_PATH.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npm install -g agent-browser@0.25.3 && \
    npx playwright install chromium && \
    chmod -R o+rx /opt/playwright-browsers

# Create a stable symlink to whatever chromium binary got installed, so our
# runtime code can point at a fixed path rather than globbing. Playwright's
# layout (chrome-linux vs chrome-linux64 vs chrome-headless-shell-linux64) has
# shifted between versions, so we use find to locate the binary regardless.
# Prefer headless_shell (smaller); fall back to full chrome. Build fails loudly
# if neither is present.
RUN bin=$(find /opt/playwright-browsers -type f -name headless_shell -perm -u+x 2>/dev/null | head -n 1); \
    if [ -z "$bin" ]; then \
      bin=$(find /opt/playwright-browsers -type f -name chrome -perm -u+x 2>/dev/null | head -n 1); \
    fi; \
    if [ -z "$bin" ]; then \
      echo "No chromium binary found under /opt/playwright-browsers" >&2; \
      ls -laR /opt/playwright-browsers >&2; \
      exit 1; \
    fi; \
    ln -sf "$bin" /opt/playwright-browsers/chromium-current; \
    echo "Linked /opt/playwright-browsers/chromium-current -> $bin"

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

# Functional smoke test: the bash step above confirms a binary exists under
# /opt/playwright-browsers and is marked executable. This step additionally
# invokes the runtime resolver (catching drift between the TS CHROMIUM_PATH
# and the symlink above) and runs `--version` on the resolved binary to
# catch a non-functional install (corrupt file, missing shared libs, etc.).
RUN node dist/scripts/assert-chromium-available.js

# Create non-root user for running Claude Code
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app /workspace && \
    if [ -d /root/.agent-browser/browsers ]; then \
      mkdir -p /home/claude/.agent-browser && \
      mv /root/.agent-browser/browsers /home/claude/.agent-browser/browsers && \
      chown -R claude:claude /home/claude/.agent-browser; \
    fi

# Copy skills and settings into the user's Claude config directory (after user creation)
COPY skills/ /home/claude/.claude/skills/
COPY settings.json /home/claude/.claude/settings.json
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
# Point agent-browser at the chromium binary installed under PLAYWRIGHT_BROWSERS_PATH.
# agent-browser's built-in discovery only finds Playwright's chromium at the old
# chrome-linux64/chrome subpath — newer playwright-core installs to chrome-linux/chrome
# (and chromium_headless_shell-*/chrome-linux/headless_shell), so its search misses.
# Rather than fighting the layout with symlinks (brittle across playwright versions),
# we point agent-browser at the stable chromium-current symlink the Dockerfile sets up.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/playwright-browsers/chromium-current
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage,--disable-blink-features=AutomationControlled,--disable-features=AutomationControlled,--disable-infobars,--disable-background-timer-throttling,--disable-popup-blocking,--disable-backgrounding-occluded-windows,--disable-renderer-backgrounding,--disable-component-update"
ENV AGENT_BROWSER_USER_AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
ENV AGENT_BROWSER_PROFILE=/workspace/.browser-profile
ENV DISABLE_AUTOUPDATER=1
# Disable automatic MCP tool deferral until tested — re-enable with 'auto:10' or 'true'
ENV ENABLE_TOOL_SEARCH=false

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "dist/server.js"]
