# Base image is glibc-based. If this ever changes to a musl distro (e.g. Alpine),
# the Agent SDK native-binary cleanup step below must flip: delete the `-glibc`
# variant instead of the `-musl` one, or the Claude subprocess will fail to spawn.
#
# Stage layout: `base` holds the agent's tool environment (apt packages,
# runtimes, browser) and is shared by `builder` (dev deps + tsc, discarded)
# and `runtime` (prod deps + dist, published).
FROM ubuntu:22.04 AS base

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies. --no-install-recommends everywhere: Ubuntu
# otherwise drags in recommended packages nobody uses; the tools named here
# arrive via hard Depends.
RUN apt-get update && apt-get install -y --no-install-recommends \
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
    # Document/media reading (formats the product renders)
    poppler-utils \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Python 3.11 and pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3-pip \
    python3.11-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python

# Install UV (Universal Virtualenv)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install TypeScript and ts-node globally. npm's download cache must be
# flushed in the SAME layer — anything left in /root/.npm ships in the image
# (and, being pre-compressed tarballs, doesn't even gzip away on the wire).
RUN npm install -g typescript ts-node && rm -rf /root/.npm

# Install Bun (for running dashboard servers)
# Install as root then copy binary to /usr/local/bin so the claude user can access it
# (symlinks to /root/.bun/bin/ won't work because /root/ is not readable by other users).
# Remove the installer's /root/.bun copy in the same layer or the ~90MB binary ships twice.
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx && \
    chmod 755 /usr/local/bin/bun && \
    rm -rf /root/.bun

# Install Chromium dependencies (needed by agent-browser)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
    libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser (native Rust binary since v0.20.0) and Playwright's
# Chromium headless shell. Both the agent-browser runtime (via
# AGENT_BROWSER_EXECUTABLE_PATH) and our dashboard screenshot code (via
# playwright-core) launch the chromium-current symlink, which resolves to
# headless_shell — so only the shell is installed (--only-shell). The full
# chromium build was ~640MB of never-launched weight.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npm install -g agent-browser@0.27.2 && \
    npx playwright install chromium --only-shell && \
    chmod -R o+rx /opt/playwright-browsers && \
    rm -rf /root/.npm

# Create a stable symlink to whatever chromium binary got installed, so our
# runtime code can point at a fixed path rather than globbing. Playwright's
# layout AND binary name shift across versions and arches: arm64 unpacks to
# chrome-linux/headless_shell while amd64 unpacks to
# chrome-headless-shell-linux64/chrome-headless-shell. Find either headless
# binary name; fall back to full chrome. Build fails loudly if none is present.
RUN bin=$(find /opt/playwright-browsers -type f \( -name headless_shell -o -name chrome-headless-shell \) -perm -u+x 2>/dev/null | head -n 1); \
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

# Create the non-root user and its directories up front so every layer below
# can create files with the right owner. Ownership fixes must happen in the
# SAME layer that creates the files: a later `chown -R` (or `rm`) of a lower
# layer copies up (or merely whiteouts) every file, shipping ~400MB twice.
RUN useradd -m -s /bin/bash claude && \
    install -d -o claude -g claude /app /workspace /home/claude/.claude
WORKDIR /app

# ---- builder: dev install + TypeScript build ----
# Nothing from this stage ships except /app/dist, so devDeps (typescript,
# ts-node, vitest, @types/*) never reach the runtime image.
FROM base AS builder

COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM base AS runtime

# Copy package files
COPY --chown=claude:claude package*.json ./

# Install production dependencies only. The Agent SDK ships per-platform
# native Claude Code binaries as optional dependencies; npm picks the matching
# one for this arch (e.g. @anthropic-ai/claude-agent-sdk-linux-arm64/claude).
#
# In the same layer (see note above), drop the musl SDK variant if npm
# installed it alongside the glibc one. Our base image is glibc-based Ubuntu
# (see note at top of file), but npm sometimes ignores the package's `libc`
# field and installs both. The SDK's resolver prefers the musl binary when
# present, which then fails at runtime with "binary not found" (the kernel
# can't load it because ld-musl-<arch>.so isn't on the image). If the base
# image ever switches to musl (Alpine), invert this: delete the non-musl
# variants instead.
RUN npm ci --omit=dev && \
    rm -rf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl /root/.npm && \
    chown -R claude:claude /app

# Expose the SDK-bundled claude binary on PATH so shell invocations
# (`claude -p ...`) inside the container still work. Find-based resolution
# keeps this portable across platforms — the matching optional dep name
# varies by os/arch.
RUN bin=$(find /app/node_modules/@anthropic-ai -maxdepth 2 -type d -name 'claude-agent-sdk-*' 2>/dev/null | head -n 1)/claude; \
    if [ -x "$bin" ]; then \
      ln -sf "$bin" /usr/local/bin/claude; \
      echo "Symlinked /usr/local/bin/claude -> $bin"; \
    else \
      echo "No SDK-bundled claude binary found under /app/node_modules/@anthropic-ai/" >&2; \
      ls -la /app/node_modules/@anthropic-ai/ >&2; \
      exit 1; \
    fi

# Compiled output from the builder stage
COPY --from=builder --chown=claude:claude /app/dist ./dist

# Functional smoke test: the bash step above confirms a binary exists under
# /opt/playwright-browsers and is marked executable. This step additionally
# invokes the runtime resolver (catching drift between the TS CHROMIUM_PATH
# and the symlink above) and runs `--version` on the resolved binary to
# catch a non-functional install (corrupt file, missing shared libs, etc.).
RUN node dist/scripts/assert-chromium-available.js

# Legacy agent-browser (<0.20) downloaded browsers into /root; move them where
# the claude user can reach them. No-op with the native-binary versions.
RUN if [ -d /root/.agent-browser/browsers ]; then \
      mkdir -p /home/claude/.agent-browser && \
      mv /root/.agent-browser/browsers /home/claude/.agent-browser/browsers && \
      chown -R claude:claude /home/claude/.agent-browser; \
    fi

# Copy skills into the user's Claude config directory (after user creation).
# NOTE: session-transcript retention (cleanupPeriodDays) is NOT set here. The
# CLI reads its user settings.json from CLAUDE_CONFIG_DIR (/workspace/.claude),
# not ~/.claude, so a settings.json baked in here would be ignored. The
# SessionManager provisions /workspace/.claude/settings.json at runtime instead
# (see agent-container/src/session-manager.ts:ensureClaudeSettings).
COPY --chown=claude:claude skills/ /home/claude/.claude/skills/

# Platform capability guides are image-owned rather than stored in /workspace,
# which is replaced by a writable per-agent bind mount at runtime. The agent can
# read these guides on demand but cannot edit them.
COPY --chown=root:root docs/ /opt/gamut/docs/
RUN chmod -R a-w /opt/gamut/docs

# Switch to non-root user
USER claude

# Expose port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/home/claude
ENV CLAUDE_CODE_ATTRIBUTION_HEADER=0
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
# Default to on; the host overrides at `docker run` from LLM settings.
ENV ENABLE_TOOL_SEARCH=true

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "dist/server.js"]
