<p align="center">
  <img src="build/icon.png" height="128">
  <h1 align="center">SuperAgent - AI Agent Platform</h1>
</p>

SuperAgent is a super app for building and running personal agents. You can create custom agents, let them develop the skills they need to do task for you, and have them run automatocally in the background for you.

| Windows | Mac |
|:-------:|:---:|
| [Download for Windows](https://github.com/SkillfulAgents/SuperAgent/releases/latest/download/Superagent-Setup.exe) | [Download for Mac](https://github.com/SkillfulAgents/SuperAgent/releases/latest/download/Superagent-arm64.dmg) |

**Features:**

- **Containerized Agents** - SuperAgents spins up a containerized sandbox per agent - keeping your computer secure. 
- **Connected Accounts** - easily connect 100s of accounts your agent can use.
- **Secure Integrations** - API calls are proxied outside your agent and the agent never sees Auth Tokens, keeping your account secure and giving you an audit trail of agent actions.
- **Recurring and Scheduled Tasks** - agents can schedule recurring tasks and future work so they can serve you autonomously in the background.
- **Browser Access** - agents can spin up and use a web browser to accomplish tasks where no API / MCP is available.
- **Agent Dashboards & Artifacts** - agents can create dashboard for you to more easily access information.
- **Create Shared Skillsets** - as agents create skills for your work - creaate skillsets to share them with your team!

**Run as:**

- **Web App** - you can run super agent in server mode and access it via the web. Great if you have a computer that can run it 24/7
- **Desktop App** - you can download and run superagent locally in your machine as a desktop app.

## Pre-Reqs

To get strated with Superagent, you need:

1. **A container runtime** -> this is where SuperAgent will run it’s agent containers. Our recommendations:
  1. [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/)
  2. [OrbStack](https://orbstack.dev/download)
  3. [Podman](https://podman.io/get-started)
2. **An Anthropic API Key** -> we currently only support Anthropic models, more coming soon. Get your API key from the [Anthropic Console](https://platform.claude.com/settings/keys).
3. **[Optional] A Composio API key** -> SuperAgent uses Composio to generate OAuth Tokens for you for different acocunts. You can get one on [Composio](https://platform.composio.dev).


# Getting Started

## Desktop App
Download the latest release from the links above, or visit the [releases page](https://github.com/SkillfulAgents/SuperAgent/releases/latest).

## Running with Docker

You can run Superagent in a Docker container using Docker-outside-of-Docker (DooD) to spawn agent containers.

### Using the published image

```bash
# Set your API key
export ANTHROPIC_API_KEY=your-api-key-here

# Pull and run
docker compose up

# Access at http://localhost:47891
```

### Building locally

```bash
# Build and run from source
docker compose up --build
```

### How it works

The Docker setup:
- Mounts the Docker socket for spawning sibling agent containers
- Persists data in `~/.superagent` (same path on host and container)
- Mounts `./agent-container` for building agent images on-demand

The image is published to `ghcr.io/iddogino/superagent` on every push to main and on version tags.

## Running from Source

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the agent container:
   ```bash
   npm run build:container
   ```

3. Set up environment variables (see below)

4. Create the local data directory:
   ```bash
   mkdir -p ~/.superagent
   ```

5. Run database migrations:
   ```bash
   npm run db:migrate
   ```

6. Start the development server:
   ```bash
   npm run dev
   ```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (required) | - |
| `SUMMARIZER_MODEL` | Model used for generating session names | `claude-haiku-4-5` |
| `CONTAINER_STATUS_SYNC_INTERVAL_SECONDS` | How often to sync container status with Docker (seconds) | `300` |
| `RUNNER_AVAILABILITY_CACHE_TTL_SECONDS` | How long to cache Docker/Podman availability checks (seconds) | `60` |

## Auth Mode (Multi-User)

Superagent can run in **auth mode** for multi-user deployments with role-based access control. When enabled, users sign up and sign in with email/password, and agents are isolated per user via ACLs.

### How it works

- The first user to sign up is automatically promoted to **admin**.
- Subsequent users sign up as regular users.
- Admins can manage users and access global settings (LLM keys, runtime config).
- Each agent has an **owner** (the creator) who can invite other users as **user** (can chat) or **viewer** (read-only).
- Auth mode is **web-only** — the Electron desktop app always runs in single-user mode.

### Enabling auth mode

`AUTH_MODE` is a **compile-time setting** for the frontend (Vite injects it as `__AUTH_MODE__`), so it must be set at build time.

**Using the published Docker image:**

Pre-built auth images are published with the `-auth` suffix:

```bash
SUPERAGENT_IMAGE=ghcr.io/skillfulagents/superagent:main-auth \
ANTHROPIC_API_KEY=your-api-key \
docker compose up
```

**From source:**

```bash
AUTH_MODE=true npm run dev
```

**Building Docker locally:**

```bash
AUTH_MODE=true docker compose up --build
```

### Docker image tags

Both regular and auth-enabled images are published on every push to `main` and on version tags:

| Tag | Description |
|-----|-------------|
| `main` | Latest from main branch (single-user) |
| `main-auth` | Latest from main branch (multi-user auth) |
| `X.Y.Z` | Version release (single-user) |
| `X.Y.Z-auth` | Version release (multi-user auth) |
| `X.Y` | Major.minor release (single-user) |
| `X.Y-auth` | Major.minor release (multi-user auth) |

### Auth environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BETTER_AUTH_SECRET` | Secret key for signing session cookies (min 32 chars). If not set, a secret is auto-generated and persisted to `$SUPERAGENT_DATA_DIR/.auth-secret`. | Auto-generated |
| `TRUSTED_ORIGINS` | Comma-separated list of allowed origins for CORS and CSRF protection. The first origin is also used as the app's base URL for OAuth callbacks. Example: `https://superagent.example.com` | None (permissive CORS) |
| `HOST` | Server hostname, used to construct the auth base URL when `TRUSTED_ORIGINS` is not set. | `localhost` |
| `PORT` | Server port, used to construct the auth base URL when `TRUSTED_ORIGINS` is not set. | `47891` |
| `USE_HTTPS` | Use `https` protocol in the auth base URL when `TRUSTED_ORIGINS` is not set. | `false` |

### Example: production deployment

```bash
SUPERAGENT_IMAGE=ghcr.io/iddogino/superagent:main-auth \
ANTHROPIC_API_KEY=your-api-key \
TRUSTED_ORIGINS=https://superagent.example.com \
BETTER_AUTH_SECRET=your-secret-key-at-least-32-characters-long \
docker compose up
```

The runtime variables (`TRUSTED_ORIGINS`, `BETTER_AUTH_SECRET`, etc.) are passed through automatically by the compose file.

### Optional: Composio OAuth setup

If you connect accounts through Composio (Slack/Gmail/GitHub, etc.), make sure token masking is disabled in your Composio project settings, otherwise SuperAgent cannot read usable access tokens and proxy calls may fail.

In the Composio dashboard, go to:
- `Project Settings`
- `Project Configuration`
- Disable `Mask Connected Account Secrets`

After changing this setting, reconnect the account in SuperAgent.

Create a `.env.local` file in the project root:

```bash
ANTHROPIC_API_KEY=your-api-key-here
# Optional overrides
# SUMMARIZER_MODEL=claude-haiku-4-5
# CONTAINER_STATUS_SYNC_INTERVAL_SECONDS=300
# RUNNER_AVAILABILITY_CACHE_TTL_SECONDS=60
```

[[Finish this section -- get to a running server]]

# Development

## Scripts

### Development
| Script | Description |
|--------|-------------|
| `npm run dev` | Start web app + API server in parallel |
| `npm run dev:api` | Start API server only (port 3001) |
| `npm run dev:web` | Start Vite dev server only (port 3000) |
| `npm run dev:electron` | Start Electron app in development |

### Build
| Script | Description |
|--------|-------------|
| `npm run build` | Build web app + API for production |
| `npm run build:web` | Build web frontend only |
| `npm run build:api` | Build API server only |
| `npm run build:electron` | Build Electron app |
| `npm run build:container` | Build the agent Docker container |

### Distribution
| Script | Description |
|--------|-------------|
| `npm run dist:mac` | Package Electron app for macOS |
| `npm run dist:win` | Package Electron app for Windows |
| `npm run preview` | Build and run production server locally |

### Quality
| Script | Description |
|--------|-------------|
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm test` | Run tests in watch mode |
| `npm run test:run` | Run tests once |
| `npm run test:coverage` | Run tests with coverage |

### Database
| Script | Description |
|--------|-------------|
| `npm run db:migrate` | Run database migrations |
| `npm run db:generate` | Generate new migration |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run db:reset` | Reset database |

## Architecture

The application uses a dual-target architecture supporting both web and Electron desktop deployment:

### Web Mode
- **Frontend**: Vite dev server (port 3000) proxies API requests to the backend
- **Backend**: Hono server (port 3001) handles API routes and serves static files in production

### Electron Mode
- **Main Process**: Starts embedded Hono API server and creates browser window
- **Renderer Process**: Same React app as web, communicates with API via localhost
- **Preload Script**: Exposes safe IPC methods to renderer

### Agent Containers
Each agent runs in its own Docker/Podman container with Claude Code in headless mode:
- Containers communicate via HTTP/WebSocket APIs
- SSE streaming for real-time message updates
- File-based persistence for agents, sessions, and messages
- SQLite database for OAuth connected accounts
