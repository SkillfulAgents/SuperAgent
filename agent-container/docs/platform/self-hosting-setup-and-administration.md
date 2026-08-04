---
title: How is Gamut self-hosted and administered?
description: Self-hosting: deployment options (desktop app, Docker, auth mode), runtime and LLM configuration, and administration.
source_url:
  - https://www.gamut.so/docs/self-hosting/deployment-options/electron-desktop-app
  - https://www.gamut.so/docs/self-hosting/deployment-options/single-user-docker
  - https://www.gamut.so/docs/self-hosting/deployment-options/auth-mode
  - https://www.gamut.so/docs/self-hosting/configuration/runtime-setup
  - https://www.gamut.so/docs/self-hosting/configuration/llm-providers
  - https://www.gamut.so/docs/self-hosting/configuration/computer-use
  - https://www.gamut.so/docs/self-hosting/configuration/voice-input
  - https://www.gamut.so/docs/self-hosting/administration/usage-and-costs
  - https://www.gamut.so/docs/self-hosting/administration/audit-logging
  - https://www.gamut.so/docs/self-hosting/administration/notifications
---

## Electron Desktop App

The Superagent desktop app is the simplest way to get started. It packages the full Superagent server, web UI, and container runtime management into a single native application for macOS and Windows.

### When to choose this option

- You are a single user running Superagent on your own machine.
- You want the quickest path from download to working agents.
- You prefer a native app experience with system tray, notifications, and auto-updates.
- You do not need remote access or multi-user authentication.

### System requirements

| | macOS | Windows |
|---|---|---|
| **OS version** | macOS 12 (Monterey) or later | Windows 10 or later |
| **Architecture** | Intel (x64) or Apple Silicon (arm64) | x64 or arm64 |
| **Container runtime** | [Docker Desktop](https://docs.docker.com/desktop/), [OrbStack](https://orbstack.dev/), or [Podman](https://podman.io/) | [Docker Desktop](https://docs.docker.com/desktop/) (WSL 2 backend) |

A container runtime must be installed and running before you launch Superagent. Each agent runs inside its own isolated container, so the runtime is required for agent execution.

### Download and install

Download the latest release from the [GitHub Releases page](https://github.com/SkillfulAgents/SuperAgent/releases).

**macOS:** Download the `.dmg` file for your architecture. Open the disk image and drag Superagent to your Applications folder. On first launch, macOS may show a security prompt -- click "Open" to allow it. The app is code-signed and notarized by Apple.

**Windows:** Download the `Superagent-Setup.exe` installer. Run the installer -- it will guide you through choosing an installation directory and creating shortcuts. The installer creates both a desktop shortcut and a Start Menu entry.

### What is included

The desktop app bundles:

- **API server** -- The Hono-based API server starts automatically on port 47891 (or the next available port) when the app launches.
- **Web UI** -- The React frontend is served from the built-in server and rendered in the Electron window.
- **Container management** -- On macOS, the app embeds a Lima virtual machine for lightweight container management alongside Docker/OrbStack/Podman support. On Windows, it uses WSL 2.
- **Database** -- A SQLite database stored in the app's data directory.

### Data directory

Superagent stores its database, agent workspaces, and configuration in a platform-specific data directory:

| Platform | Path |
|---|---|
| **macOS** | `~/Library/Application Support/Superagent/` |
| **Windows** | `%APPDATA%\Superagent\` |

This directory contains:

- `superagent.db` -- The SQLite database (agents, sessions, settings, audit logs).
- `agents/` -- Per-agent workspace directories with files, downloads, and message history.
- `settings.json` -- Application and API key configuration.

### Auto-updates

The desktop app checks for updates automatically. On launch, it checks the [GitHub releases feed](https://github.com/SkillfulAgents/SuperAgent/releases) after a 30-second delay, then rechecks every 4 hours. It also checks immediately when your machine wakes from sleep.

When an update is available, the app displays a notification in the UI. Updates are not downloaded automatically -- you choose when to download and install. Once downloaded, the update is applied the next time you quit and relaunch the app.

You can also check for updates manually from the app's settings page.

**Pre-release updates:** If you opt into pre-release updates in settings, the updater checks both the pre-release and stable channels and offers whichever version is newer.

### System tray

On macOS and Windows, Superagent places an icon in the system tray (menu bar on macOS, notification area on Windows). The tray menu shows:

- **Open Superagent** -- Bring the main window to the front.
- **Agent status** -- A grouped list of your agents organized by status (Needs Input, Working, Idle, Sleeping). Click any agent to navigate directly to it.
- **Quit** -- Shut down all agents and exit the application.

The tray icon can be toggled on or off in the app settings. When the tray is active, closing the main window keeps the app running in the background so agents can continue working. On Linux, closing all windows quits the application.

### Notifications

The desktop app supports native OS notifications for agent events:

- **Session complete** -- An agent finished its task.
- **Session waiting** -- An agent needs your input.
- **Scheduled session** -- A scheduled task has started.

Notifications work even when the main window is closed. Clicking a notification opens the app and navigates directly to the relevant agent and session. On macOS, notifications include action buttons (such as Approve/Deny for API request reviews).

Each notification type can be individually enabled or disabled in settings.

### Keep awake (macOS)

On macOS, you can enable "Keep Awake" to prevent your machine from sleeping while agents are running. This uses macOS's `pmset disablesleep` command and requires a one-time administrator password prompt to install a passwordless sudoers rule.

### Deep links

The desktop app registers a custom URL scheme (`superagent://`) for deep linking:

- `superagent://agent/{slug}` -- Open the app and navigate to a specific agent.
- `superagent://dashboard/{agent}/{dashboard}` -- Open a dashboard in a standalone window.

Dashboards can be added to the macOS Dock as standalone app shortcuts through the dashboard context menu.

### Next steps

- [Quickstart](https://www.gamut.so/docs/using-superagent/getting-started/quickstart) -- Create your first agent.
- [Single-User Docker](https://www.gamut.so/docs/self-hosting/deployment-options/single-user-docker) -- Run Superagent as a Docker container for headless or remote access.
- [Auth Mode (Multi-User)](https://www.gamut.so/docs/self-hosting/deployment-options/auth-mode) -- Deploy Superagent for a team with authentication and access control.

## Single-User Docker

Running Superagent as a Docker container is the recommended approach for headless servers, remote access, and environments where you want to manage Superagent alongside other containerized services.

In single-user mode, there is no login screen -- the app is open to anyone who can reach the port. This is appropriate when you are the only user, or when network-level access controls (VPN, firewall, reverse proxy with authentication) restrict who can connect.

### When to choose this option

- You want to run Superagent on a remote server or NAS and access it from a browser.
- You prefer headless, always-on operation without a desktop environment.
- You are a single user or rely on network-level access control.
- You want to manage Superagent with Docker Compose alongside other services.

For multi-user deployments with built-in authentication, see [Auth Mode](https://www.gamut.so/docs/self-hosting/deployment-options/auth-mode).

### Prerequisites

- **Docker Engine** (or Docker Desktop) with Docker Compose v2.
- **An Anthropic API key** from the [Anthropic Console](https://platform.claude.com/settings/keys).

### Published image

Superagent publishes pre-built container images to the GitHub Container Registry:

```
ghcr.io/skillfulagents/superagent:main
```

**Available tags:**

| Tag | Description |
|---|---|
| `main` | Latest build from the main branch (single-user mode). |
| `main-auth` | Latest build with authentication enabled. See [Auth Mode](https://www.gamut.so/docs/self-hosting/deployment-options/auth-mode). |
| `0.3.30` | Pinned release version (single-user). |
| `0.3.30-auth` | Pinned release version with auth. |
| `0.3` | Latest patch in the 0.3.x line (single-user). |
| `0.3-auth` | Latest patch in the 0.3.x line with auth. |

Images are built for both `linux/amd64` and `linux/arm64`.

### Quick start

Create a `.env` file with your API key:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Create a `docker-compose.yml`:

```yaml
services:
  superagent:
    image: ghcr.io/skillfulagents/superagent:main
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${HOME}/.superagent:${HOME}/.superagent
    environment:
      - SUPERAGENT_DATA_DIR=${HOME}/.superagent
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - PORT=47891
```

Start the container:

```bash
docker compose up -d
```

Open your browser to `http://localhost:47891` (or your server's IP address).

### Docker Compose reference

Here is a complete `docker-compose.yml` with all common options:

```yaml
services:
  superagent:
    image: ghcr.io/skillfulagents/superagent:main
    restart: unless-stopped

    # Host networking is required. Agent containers publish ports on the
    # host, and the main Superagent container connects to them via
    # 127.0.0.1. Without host networking, 127.0.0.1 inside the main
    # container would be its own loopback, not the host's.
    network_mode: host

    volumes:
      # Docker-outside-of-Docker: mount the Docker socket so Superagent
      # can create sibling containers for each agent.
      - /var/run/docker.sock:/var/run/docker.sock

      # Persistent data directory. The path inside the container must
      # match the host path so that bind-mounted agent workspaces
      # resolve correctly when passed to sibling containers.
      - ${HOME}/.superagent:${HOME}/.superagent

    environment:
      - SUPERAGENT_DATA_DIR=${HOME}/.superagent
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - PORT=47891
```

### How it works

Superagent uses **Docker-outside-of-Docker (DooD)** to manage agent containers. The main Superagent container does not run a Docker daemon inside itself. Instead, it mounts the host's Docker socket (`/var/run/docker.sock`) and issues Docker commands to the host daemon, creating sibling containers on the host.

This means:

- Agent containers run as peers alongside the Superagent container on the host.
- Agent containers publish ports on the host's network interface.
- The Superagent container must use `network_mode: host` so it can reach those ports via `127.0.0.1`.

### Volume persistence

All Superagent state is stored in the data directory (`~/.superagent` by default). This includes:

| Path | Contents |
|---|---|
| `superagent.db` | SQLite database (agents, sessions, scheduled tasks, audit logs, settings). |
| `agents/` | Per-agent directories containing workspaces, message history (JSONL), and downloads. |
| `settings.json` | Application configuration (container runtime, resource limits, API keys). |
| `.auth-secret` | Auto-generated secret for session signing (auth mode only). |

**Important:** The host path and the `SUPERAGENT_DATA_DIR` value must be the same path. Superagent passes this path to agent containers as a bind mount, and those containers run on the host -- so the path must be valid on the host filesystem.

To use a custom data directory:

```yaml
volumes:
  - /data/superagent:/data/superagent
environment:
  - SUPERAGENT_DATA_DIR=/data/superagent
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key. Agents use this to call Claude. |
| `SUPERAGENT_DATA_DIR` | No | `~/.superagent` | Path to the persistent data directory. |
| `PORT` | No | `47891` | Port the web server listens on. |

Additional API keys for optional integrations (Composio, Browserbase, OpenAI, Deepgram, etc.) can be configured through the Settings page in the UI after the container is running.

### Port configuration

The default port is **47891**. Since the container uses host networking, the port is exposed directly on the host. To change it, set the `PORT` environment variable:

```yaml
environment:
  - PORT=8080
```

Then access Superagent at `http://your-server:8080`.

### Updating

To update to the latest version:

```bash
docker compose pull
docker compose up -d
```

Your data is preserved in the mounted volume. The SQLite database schema is migrated automatically on startup when needed.

To pin a specific version instead of tracking `main`:

```yaml
image: ghcr.io/skillfulagents/superagent:0.3.30
```

### Building from source

If you prefer to build the image locally:

```bash
git clone https://github.com/SkillfulAgents/SuperAgent.git
cd SuperAgent
docker compose build
docker compose up -d
```

The `docker-compose.yml` in the repository includes a `build` section that builds the image from the local Dockerfile.

### Next steps

- [Auth Mode (Multi-User)](https://www.gamut.so/docs/self-hosting/deployment-options/auth-mode) -- Add authentication for team deployments.
- [Electron Desktop App](https://www.gamut.so/docs/self-hosting/deployment-options/electron-desktop-app) -- Run Superagent as a native desktop application instead.

## Auth Mode (Multi-User)

Auth mode adds a full authentication and authorization layer to Superagent, turning it into a multi-user deployment suitable for teams. Users sign in with email/password or an OIDC provider, and access to agents is controlled through a role-based permission system.

### When to choose this option

- Multiple people need to access the same Superagent instance.
- You need per-user accounts with audit trails.
- You want to control who can view, use, or manage each agent.
- You are deploying Superagent as shared team infrastructure.

For single-user deployments without authentication, see [Single-User Docker](https://www.gamut.so/docs/self-hosting/deployment-options/single-user-docker).

### Published image

Auth mode requires a dedicated image that has the authentication frontend compiled in. The frontend is compiled with `AUTH_MODE=true` at build time, which enables the login UI and session management in the client.

```
ghcr.io/skillfulagents/superagent:main-auth
```

The `-auth` suffix is the key difference from the single-user image:

| Tag | Description |
|---|---|
| `main-auth` | Latest build from the main branch with auth enabled. |
| `0.3.30-auth` | Pinned release version with auth. |
| `0.3-auth` | Latest patch in the 0.3.x line with auth. |

### Quick start

Create a `.env` file:

```bash
ANTHROPIC_API_KEY=sk-ant-...
BETTER_AUTH_SECRET=your-random-secret-at-least-32-characters
```

Create a `docker-compose.yml`:

```yaml
services:
  superagent:
    image: ghcr.io/skillfulagents/superagent:main-auth
    restart: unless-stopped
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${HOME}/.superagent:${HOME}/.superagent
    environment:
      - SUPERAGENT_DATA_DIR=${HOME}/.superagent
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - PORT=47891
      - AUTH_MODE=true
      - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
      - TRUSTED_ORIGINS=${TRUSTED_ORIGINS:-}
```

Start the container:

```bash
docker compose up -d
```

Open your browser to `http://localhost:47891`. You will see a sign-up page. The first account you create automatically becomes the admin.

### Environment variables

In addition to the [standard environment variables](https://www.gamut.so/docs/self-hosting/deployment-options/single-user-docker#environment-variables), auth mode uses:

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_MODE` | Yes | `false` | Must be `true` to enable authentication. |
| `BETTER_AUTH_SECRET` | Recommended | Auto-generated | Secret key for signing session tokens. If not set, a random secret is generated and persisted to `.auth-secret` in the data directory. Set this explicitly for reproducible deployments or when running multiple replicas. |
| `TRUSTED_ORIGINS` | Conditional | -- | Comma-separated list of allowed origins for CORS and CSRF protection (e.g., `https://superagent.example.com`). Required when accessing Superagent through a reverse proxy or custom domain. When unset, all origins are allowed. |
| `AUTH_PROVIDERS_JSON` | No | -- | JSON array configuring OIDC providers. See [OIDC / social login](#oidc--social-login) below. |

### Authentication methods

#### Email and password

Email/password authentication is enabled by default. Users create an account with an email address and a password that meets the configured policy (minimum 12 characters with uppercase, lowercase, number, and symbol by default).

#### OIDC / social login

Superagent supports any OpenID Connect (OIDC) identity provider -- Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak, and others. OIDC providers are configured through the `AUTH_PROVIDERS_JSON` environment variable.

```bash
AUTH_PROVIDERS_JSON='[
  {
    "id": "google",
    "type": "oidc",
    "displayName": "Google",
    "discoveryUrl": "https://accounts.google.com/.well-known/openid-configuration",
    "clientId": "your-client-id.apps.googleusercontent.com",
    "clientSecret": "your-client-secret",
    "scopes": ["openid", "email", "profile"]
  }
]'
```

Each provider entry supports:

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique identifier for this provider. |
| `type` | Yes | Must be `oidc`. |
| `displayName` | No | Label shown on the login button. Defaults to `id`. |
| `discoveryUrl` | Conditional | OIDC discovery endpoint URL. Required if `issuer` is not set. |
| `issuer` | Conditional | Token issuer URL. Required if `discoveryUrl` is not set. |
| `clientId` | Yes | OAuth client ID from your identity provider. |
| `clientSecret` | No | OAuth client secret. Not required for PKCE-only flows. |
| `scopes` | No | OAuth scopes to request. Defaults to the provider's standard scopes. |
| `icon` | No | URL or path to a custom icon for the login button. |
| `enabled` | No | Set to `false` to disable without removing the configuration. Defaults to `true`. |

All OIDC flows use PKCE (Proof Key for Code Exchange) for security.

You can configure multiple providers. Each appears as a separate button on the login screen.

### First user becomes admin

The very first user to sign up on a fresh Superagent instance is automatically promoted to the **admin** role. This happens atomically -- the promotion only applies if the user table has exactly one row after account creation.

This bootstrapping mechanism means you do not need any special setup to create the initial admin. Just start the container, visit the sign-up page, and create your account.

### Role-based access control

Auth mode has two layers of roles: **app-level roles** that control global permissions, and **agent-level roles** that control access to individual agents.

#### App-level roles

| Role | Capabilities |
|---|---|
| **Admin** | Full access to everything. Can manage users (ban, unban, promote, set passwords). Can access all agents regardless of agent-level roles. Can configure auth settings, signup modes, and password policies. |
| **User** | Can access only agents they have been explicitly granted a role on. Cannot manage other users or global settings. |

#### Agent-level roles

Each agent has its own access control list (ACL). Users are granted one of three roles per agent:

| Role | Capabilities |
|---|---|
| **Owner** | Full control over the agent. Can modify the agent's configuration, manage its ACL (grant/revoke access for other users), and delete it. |
| **User** | Can interact with the agent -- send messages, view sessions, trigger tasks. Cannot modify the agent's settings or manage its ACL. |
| **Viewer** | Read-only access. Can view the agent's sessions and history but cannot send messages or trigger actions. |

The role hierarchy is strict: owner > user > viewer. A middleware check requiring "user" access will also pass for "owner", and a check requiring "viewer" access will pass for both "user" and "owner".

**Admins bypass all agent-level checks.** An admin can access any agent without needing an explicit ACL entry.

When a user creates an agent, they are automatically assigned the **owner** role on that agent.

### Signup and access control

Admins can configure how new users join the instance through the admin settings panel:

| Signup mode | Behavior |
|---|---|
| **Invitation only** (default) | Only admins can create new accounts. The sign-up page is disabled. |
| **Open** | Anyone can create an account by visiting the sign-up page. |
| **Domain restricted** | Only email addresses from specified domains (e.g., `yourcompany.com`) can sign up. |
| **Closed** | No new signups of any kind. |

#### Admin approval

When enabled, new users are automatically banned with the reason "Pending admin approval" after signing up. They cannot log in until an admin unbans their account. This works in combination with open or domain-restricted signup modes to give admins a review step before granting access.

#### Disabling auth methods

Admins can independently enable or disable:

- **Email/password authentication** -- Disable to force OIDC-only login.
- **Social/OIDC authentication** -- Disable to force email/password-only login.

### Password policy

The default password policy requires:

- Minimum 12 characters (configurable).
- Maximum 128 characters (configurable).
- At least one uppercase letter, one lowercase letter, one number, and one symbol (complexity requirement, can be disabled).

These settings are enforced on both sign-up and password change.

### Session management

| Setting | Default | Description |
|---|---|---|
| **Session lifetime** | 24 hours | Maximum session duration before forced re-authentication. |
| **Idle timeout** | 60 minutes | Session expires after this period of inactivity. |
| **Max concurrent sessions** | 5 | Oldest session is revoked when the limit is exceeded. |

### Account lockout

After 10 consecutive failed login attempts (configurable), the account is locked for 30 minutes (configurable). The lockout is per-email and resets on successful login.

### User management

Admins can manage users through the admin panel in the UI:

- **View all users** -- See email, role, status, and creation date.
- **Ban / unban users** -- Prevent a user from logging in.
- **Promote / demote** -- Change a user's app-level role between admin and user.
- **Set password** -- Force a password reset. The user will be required to change their password on next login.
- **Approve pending users** -- When admin approval is required, approve or reject new signups.

### Data directory considerations

Auth mode can only be enabled on a **fresh data directory** or one that already has auth tables. You cannot enable auth mode on an existing single-user data directory that contains agents -- the startup validation will reject it to prevent orphaned agent data that no user owns.

If you are migrating from single-user to auth mode, start with a clean data directory.

### Docker Compose example

A complete production-ready `docker-compose.yml` with auth mode, OIDC, and trusted origins:

```yaml
services:
  superagent:
    image: ghcr.io/skillfulagents/superagent:main-auth
    restart: unless-stopped
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /data/superagent:/data/superagent
    environment:
      - SUPERAGENT_DATA_DIR=/data/superagent
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - PORT=47891
      - AUTH_MODE=true
      - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
      - TRUSTED_ORIGINS=https://superagent.example.com
      - AUTH_PROVIDERS_JSON=${AUTH_PROVIDERS_JSON:-}
```

### Limitations

- **Auth mode is web/Docker only.** The Electron desktop app does not support auth mode. If `AUTH_MODE=true` is set in an Electron environment, it is ignored with a warning.
- **OIDC providers are configured at deployment time.** Provider credentials are passed through environment variables, not through the admin UI. This keeps secrets out of the application database.

### Next steps

- [Single-User Docker](https://www.gamut.so/docs/self-hosting/deployment-options/single-user-docker) -- Simpler deployment without authentication.
- [Electron Desktop App](https://www.gamut.so/docs/self-hosting/deployment-options/electron-desktop-app) -- Run Superagent as a native desktop application.

## Runtime Setup

SuperAgent runs each agent inside an isolated container. To do this, it needs a container runtime installed and running on the host machine. This page covers the supported runtimes, how SuperAgent detects them, and the settings you can tune.

### Supported runtimes

SuperAgent supports several container runtimes. Which ones are available depends on your operating system:

| Runtime | Platforms | Notes |
| --- | --- | --- |
| **Built-in Runtime** (Lima) | macOS | Default on macOS. Bundled with the app -- no separate install needed. Uses a lightweight Linux VM. |
| **Built-in Runtime** (WSL2) | Windows | Default on Windows. Uses a Windows Subsystem for Linux 2 distro bundled with the app. |
| **macOS Container** | macOS 26+ | Native Apple container support on macOS Tahoe (26) and later. |
| **Docker** | macOS, Linux, Windows | Docker Desktop or Docker Engine. Default on Linux. |
| **Podman** | macOS, Linux | Daemonless OCI container runtime. Requires a Podman machine on macOS. |

You can change the active runtime in **Settings > Runtime > Container Runner**. If the configured runtime is not available, SuperAgent will attempt to auto-switch to another available runtime.

### How runtime detection works

On startup, SuperAgent checks each eligible runtime in the following order:

1. **Eligibility** -- Is the runtime applicable to this OS? (For example, macOS Container is only eligible on macOS 26+.)
2. **Installation** -- Is the CLI installed and found in the system PATH?
3. **Running** -- Is the daemon or VM actually running and usable?

The results are cached for 60 seconds to avoid repeatedly spawning CLI processes. You can force a refresh from the Settings UI using the refresh button next to the Container Runner selector, or the cache is automatically cleared when you start or restart a runtime.

#### Auto-start behavior

Some runtimes can be started automatically when they are installed but not running:

- **Built-in Runtime** (Lima, WSL2) and **macOS Container**: SuperAgent will attempt to start these automatically when they are the configured runtime but not yet running.
- **Docker Desktop**: On macOS and Windows, SuperAgent can launch Docker Desktop for you.
- **Podman**: On macOS, SuperAgent can start a Podman machine if one has been initialized.

If auto-start is not possible (for example, Docker Engine on Linux typically requires `sudo systemctl start docker`), the Settings UI will display instructions.

### Container image

Each agent runs inside a container built from the SuperAgent agent image. The default image is pulled from `ghcr.io/skillfulagents/superagent-agent-container-base` and is tagged to match your installed SuperAgent version.

#### Image pulling

On first launch (or after an upgrade), SuperAgent checks whether the required image exists locally. If it does not, the image is automatically pulled from the registry. The Settings UI shows a progress bar with per-layer completion status during the pull.

Before pulling, SuperAgent checks that at least 5 GB of free disk space is available. If space is insufficient, the pull is blocked and an error message is displayed.

You can override the image in **Settings > Runtime > Agent Image** if you need a custom image. Click "Use default" to revert to the version-matched image.

#### Old image cleanup

After a successful pull, SuperAgent automatically removes old images from the same registry to free disk space. Images currently in use by running containers are skipped.

### Resource limits

Each agent container is constrained by CPU and memory limits. Configure these in **Settings > Runtime**:

| Setting | Default | Options |
| --- | --- | --- |
| **CPU Limit** | 2 cores | 1, 2, 4, 6, 8 cores |
| **Memory Limit** | 4 GB | 512 MB, 1 GB, 2 GB, 4 GB, 8 GB, 16 GB, 32 GB |

These limits apply per container. If you run multiple agents simultaneously, each one uses its own allocation.

Resource limits cannot be changed while agents are running. Stop all agents first, then update the limits.

#### Built-in Runtime VM memory (Lima)

When using the Lima-based built-in runtime on macOS, an additional **VM Memory** setting controls the maximum memory available to the entire virtual machine (not per-container). Options range from 2 GB to 16 GB, defaulting to 4 GB. Changing this setting restarts the runtime VM.

### Idle timeout and auto-sleep

SuperAgent can automatically stop idle containers to conserve resources. Set the **Idle Timeout** in **Settings > Runtime** (default: 30 minutes). When a container has no active sessions and no recent activity for this duration, it is stopped. Set to 0 to disable auto-sleep.

Open dashboards count as activity -- if a user has an agent's dashboard open, the container's keep-alive timer is refreshed.

### Agent limits

Global defaults for all agent sessions can be configured in **Settings > Runtime > Agent Limits**:

| Setting | Default | Description |
| --- | --- | --- |
| **Max Output Tokens** | 32,000 | Maximum tokens per model response. |
| **Max Thinking Tokens** | Unlimited | Maximum tokens for extended thinking/reasoning. |
| **Max Turns** | Unlimited | Maximum conversation turns per session. |
| **Max Budget (USD)** | Unlimited | Maximum cost per session in USD. |

Leave any field empty to use the default.

### Custom environment variables

You can inject additional environment variables into agent containers from **Settings > Runtime > Custom Environment Variables**. These are passed to the Claude Code CLI process inside the container and apply to new sessions.

Common use cases include overriding Claude Code behavior flags, setting tool-specific API keys, or passing custom configuration to agent scripts.

Variable names are automatically normalized to uppercase with underscores (e.g., `my-var` becomes `MY_VAR`).

### Trusted origins (CORS)

When deploying SuperAgent as a web server (outside the Electron desktop app), you may need to configure trusted origins for CORS and CSRF protection. This is especially relevant when the UI is served from a different domain than the API.

#### Environment variable

Set the `TRUSTED_ORIGINS` environment variable to a comma-separated list of allowed origins:

```bash
TRUSTED_ORIGINS=https://superagent.example.com,https://admin.example.com
```

This configures the CORS middleware on all API routes.

#### Auth settings

When running in auth mode, trusted origins can also be configured in **Settings > Auth > Trusted Origins**. These origins are used for both CORS and Better Auth CSRF protection. The first trusted origin is also used as the app's external base URL for OAuth callback URLs.

If no trusted origins are configured and no `HOST` environment variable is set, the app falls back to the request's origin header.

### Key environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SUPERAGENT_DATA_DIR` | OS-specific | Base directory for all SuperAgent data (database, agent workspaces, settings). |
| `PORT` | `47891` | HTTP server port. |
| `HOST` | `localhost` | Hostname for the server. Used in OAuth callbacks and external URLs. |
| `USE_HTTPS` | `false` | Set to `true` if the server is behind an HTTPS proxy. |
| `TRUSTED_ORIGINS` | (none) | Comma-separated list of allowed CORS origins. |
| `CONTAINER_STATUS_SYNC_INTERVAL_SECONDS` | `300` | How often to sync container statuses with the runtime (seconds). |
| `CONTAINER_HEALTH_CHECK_INTERVAL_SECONDS` | `30` | How often to run container health checks (seconds). |
| `RUNNER_AVAILABILITY_CACHE_TTL_SECONDS` | `60` | How long to cache runtime availability results (seconds). |
| `E2E_MOCK` | (none) | Set to `true` to use a mock container client for testing. |

### Runtime status monitoring

SuperAgent continuously monitors the status of running containers:

- **Status sync** runs every 5 minutes (configurable) and queries the container runtime to detect containers that were stopped externally (e.g., by Docker Desktop or a system restart).
- **Health checks** run every 30 seconds (configurable) on running containers, monitoring CPU and memory usage. Warnings are broadcast to the UI when thresholds are exceeded.
- **Connection error recovery** triggers an immediate status sync when an HTTP request to a container fails, handling cases where a container crashed unexpectedly.

All status changes are broadcast to connected clients via Server-Sent Events (SSE), so the UI updates in real time.

### Data location

All SuperAgent data is stored under a single directory. The default location depends on your OS and can be overridden with the `SUPERAGENT_DATA_DIR` environment variable. The current data directory is shown (read-only) at the bottom of **Settings > Runtime**.

## LLM Providers

SuperAgent uses large language models to power every agent. You choose which provider supplies those models, configure credentials, and pick default models for different purposes. All provider settings are in **Settings > LLM**.

### Supported providers

| Provider | Description | API key field | Environment variable |
| --- | --- | --- | --- |
| **Anthropic** | Direct access to Claude via the Anthropic API. This is the primary provider. | `anthropicApiKey` | `ANTHROPIC_API_KEY` |
| **OpenRouter** | Routes requests through OpenRouter, giving access to Claude models (and others) via a single API key. | `openrouterApiKey` | `OPENROUTER_API_KEY` |
| **AWS Bedrock** | Enterprise-grade Claude inference through Amazon Bedrock. Supports both simple bearer token auth and full IAM credentials. | `bedrockApiKey` | `AWS_BEARER_TOKEN_BEDROCK` |

A fourth option, **Platform**, is available when connected to the SuperAgent platform. It uses managed credentials and requires no separate API key.

### Switching providers

Select the active provider in **Settings > LLM > Provider**. Only one provider is active at a time. Running agents continue using the previous provider until they are restarted -- a notice in the UI warns about this when you switch.

### API key management

API keys can be configured in two ways:

1. **Settings UI** -- Enter the key in **Settings > LLM** under the credentials section. Keys saved this way are stored locally in `settings.json` with file permissions restricted to the current user (mode `0600`).
2. **Environment variables** -- Set the appropriate environment variable before starting SuperAgent. If both a saved key and an environment variable exist, the saved key takes precedence.

The UI shows the current key status with a badge indicating the source ("Using saved setting" or "Using environment variable"). You can remove a saved key to fall back to the environment variable, or save a new key to override it.

#### Key validation

When you enter a key in the Settings UI, SuperAgent validates it by making a minimal API call (a single-token request to Claude Haiku). The key is only saved if validation succeeds. This catches common issues like expired keys, incorrect prefixes, or insufficient permissions.

### Anthropic (primary)

The Anthropic provider sends requests directly to the Anthropic API at `https://api.anthropic.com`.

**Environment variable**: `ANTHROPIC_API_KEY`

When a container starts, the Anthropic API key is injected via the `ANTHROPIC_API_KEY` environment variable so the Claude Code process inside the container can authenticate.

#### Available models

| Model ID | Display name | Default for |
| --- | --- | --- |
| `claude-opus-4-7` | Claude 4.7 Opus | Agent (default model) |
| `claude-opus-4-6` | Claude 4.6 Opus | -- |
| `claude-sonnet-4-6` | Claude 4.6 Sonnet | Browser agent |
| `claude-haiku-4-5` | Claude 4.5 Haiku | Summarizer |

### OpenRouter

OpenRouter provides an Anthropic-compatible API endpoint that routes requests to multiple model providers. This is useful when you want a single API key that can access Claude alongside other models, or when you need to route traffic through OpenRouter for billing or quota reasons.

**Environment variable**: `OPENROUTER_API_KEY`

When a container starts, three environment variables are injected:

- `ANTHROPIC_API_KEY` is set to an empty string (prevents the SDK from sending the `x-api-key` header).
- `ANTHROPIC_BASE_URL` is set to `https://openrouter.ai/api`.
- `ANTHROPIC_AUTH_TOKEN` carries your OpenRouter key via the `Authorization: Bearer` header.

#### Available models

The same Claude model IDs are available as with the direct Anthropic provider. The default agent model for OpenRouter is Claude 4.6 Sonnet (rather than Opus) as a cost-conscious default.

### AWS Bedrock

AWS Bedrock provides Claude model inference through Amazon's managed AI infrastructure. This is the recommended option for enterprises that route all AI traffic through their AWS account for compliance, cost allocation, or network isolation.

#### Authentication methods

Bedrock supports two authentication methods:

**Simple auth (Bearer Token)**:
- Set the `AWS_BEARER_TOKEN_BEDROCK` environment variable or enter the token in **Settings > LLM > Credentials**.
- This is the simplest option when you have a Bedrock-specific API key.

**Full AWS credentials (Access Key + Secret)**:
- Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as environment variables, or enter them in **Settings > LLM > Credentials**.
- Configure the AWS region (defaults to `us-east-1`). This can be set via the `AWS_REGION` environment variable or in settings.

If neither method is configured, Bedrock falls back to the default AWS credential chain (e.g., `~/.aws/credentials` or instance profile).

When a container starts with Bedrock as the active provider, the container receives `CLAUDE_CODE_USE_BEDROCK=1` to tell the Claude Code SDK to use Bedrock mode. The `ANTHROPIC_API_KEY` is explicitly cleared so the container does not accidentally fall back to the direct Anthropic API.

#### Available models

Bedrock uses cross-region model IDs:

| Model ID | Display name | Default for |
| --- | --- | --- |
| `us.anthropic.claude-opus-4-7` | Claude 4.7 Opus | -- |
| `us.anthropic.claude-opus-4-6-v1` | Claude 4.6 Opus | -- |
| `us.anthropic.claude-sonnet-4-6` | Claude 4.6 Sonnet | Agent, Browser agent |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Claude 4.5 Haiku | Summarizer |

### Model configuration

#### Default model

The **Default Model** in **Settings > LLM > Models** is used for new agent sessions when no per-message model is selected. This defaults to Claude Opus (the most capable model).

#### Summarizer model

The **Summarizer Model** is used for lightweight tasks such as session name generation and API key validation. Defaults to Claude Haiku for speed and cost efficiency.

#### Per-message model selector

In the message composer, users can switch between three model families on a per-message basis:

- **Opus** -- Most capable; best for complex, multi-step tasks.
- **Sonnet** -- Balanced speed and capability.
- **Haiku** -- Fastest and most affordable.

The model family selected in the composer applies to that message and persists for subsequent messages in the same session until changed.

### Tool search

The **Tool Search** toggle in **Settings > LLM > Advanced** controls whether agent containers load tool definitions on demand via a meta-tool or all at once upfront. This is enabled by default and saves approximately 15,000-20,000 context tokens per turn for SuperAgent's 60+ tool surface. Tool search requires Sonnet 4+ or Opus 4+ and is ignored on Haiku.

Disable this only when debugging tool-loading behavior.

### Environment variables reference

| Variable | Description |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key (direct provider). |
| `OPENROUTER_API_KEY` | OpenRouter API key. |
| `AWS_BEARER_TOKEN_BEDROCK` | AWS Bedrock bearer token (simple auth). |
| `AWS_ACCESS_KEY_ID` | AWS access key ID (Bedrock full credentials). |
| `AWS_SECRET_ACCESS_KEY` | AWS secret access key (Bedrock full credentials). |
| `AWS_REGION` | AWS region for Bedrock (default: `us-east-1`). |

## Computer Use

Computer Use is an Electron-only feature that allows agents to observe and interact with applications running on your host machine. Agents can list open windows, take screenshots, click buttons, type text, and run host shell commands -- all with a granular, per-agent permission system that keeps you in control.

Computer Use settings are in **Settings > Computer Use**.

### Platform availability

Computer Use is available on **macOS** and **Windows** in the Electron desktop app only. It is not available when running SuperAgent as a web server or on Linux. If you open the Computer Use settings tab on an unsupported platform, a notice explains this.

### How it works

SuperAgent uses the `@skillful-agents/agent-computer` SDK, which communicates with a local daemon (`ac-core`) running on the host machine. This daemon provides accessibility-level access to the OS, allowing agents to:

- **Observe**: List running applications, enumerate windows, take screenshots, read UI element trees, and query display information.
- **Interact**: Click elements, type text, fill form fields, press keyboard shortcuts, scroll, hover, select dropdown values, and interact with menus and dialogs.
- **Manage apps**: Launch, relaunch, quit, grab (focus), and ungrab applications.

When an agent interacts with an application, a visual halo appears around the target window to indicate that AI-driven control is active. This halo is removed when the agent releases (ungrabs) the window or the agent is stopped.

### Permission levels

Computer Use permissions are organized into three levels, from least to most powerful:

#### List Apps & Windows

**Read-only access.** The agent can list running applications, enumerate open windows, check system status, and query display information. This is the least privileged level and does not allow the agent to interact with any application.

Covers these operations: `apps`, `windows`, `status`, `displays`, `permissions`.

#### Use Application

**App-specific interaction.** The agent can interact with a specific named application -- clicking, typing, taking screenshots, reading UI trees, and more. This permission is scoped to a single app. The agent must request permission for each app it wants to control.

Covers all interaction operations: `click`, `type`, `fill`, `key`, `scroll`, `select`, `hover`, `snapshot`, `find`, `screenshot`, `read`, `launch`, `relaunch`, `quit`, `grab`, `ungrab`, `menuClick`, `dialog`.

#### Host Shell

**Shell command execution.** The agent can run shell commands and scripts on the host machine using your user permissions. This is the most powerful permission level.

### Permission grant types

When an agent requests a Computer Use permission, you choose how to grant it:

| Grant type | Duration | Persistence |
| --- | --- | --- |
| **Once** | Single use -- consumed immediately after the operation completes. | In-memory only. |
| **Timed** | 15 minutes from the time of grant. | In-memory only; lost on restart. |
| **Always** | Permanent until explicitly revoked. | Saved to `settings.json` and survives restarts. |

When an agent needs a permission it does not have, a prompt appears in the UI asking you to approve or deny the request. You select the grant type at that point.

### Managing permissions

#### Viewing active permissions

Open **Settings > Computer Use** to see all persistent ("Always Allow") permissions. Permissions are grouped by agent, showing:

- The agent's name.
- Each granted permission level and, for "Use Application" grants, the specific app name.

One-time and timed grants are not shown here because they are transient and stored only in memory.

#### Revoking permissions

You can revoke permissions at two levels of granularity:

- **Revoke a single grant**: Click the trash icon next to a specific permission entry to remove just that grant.
- **Revoke all grants for an agent**: Click "Revoke All" on the agent's permission card to remove every persistent grant for that agent.

Revoking a permission takes effect immediately. If the agent attempts the operation again, it will be prompted for a new grant.

#### Automatic cleanup

When an agent container is stopped (either manually or by auto-sleep), any active window grab for that agent is automatically released, and the visual halo disappears. Timed grants expire naturally after 15 minutes.

### macOS permissions

On macOS, Computer Use requires two system-level permissions to be granted to the SuperAgent application:

- **Accessibility**: Required for reading UI element trees, clicking, typing, and other interaction operations.
- **Screen Recording**: Required for taking screenshots.

SuperAgent checks these permissions via the `ac-core` daemon. If either permission is missing, the agent's Computer Use requests will fail. You can grant these permissions in **System Settings > Privacy & Security**.

### Security considerations

Computer Use gives agents significant power over your machine. Keep these points in mind:

- **Review each request carefully.** The permission prompt shows exactly what the agent is asking to do and which application it targets. Do not grant blanket "Always" permissions unless you trust the agent's system prompt and behavior.
- **Prefer scoped grants.** "Use Application" permissions are scoped to a single app. An agent with permission to use Safari cannot interact with your Terminal unless you grant that separately.
- **Use timed grants for exploration.** When an agent needs temporary access (for example, to debug a UI issue), a 15-minute timed grant is safer than a permanent one.
- **Host Shell is the most sensitive level.** An agent with Host Shell permission can run arbitrary commands with your user privileges. Grant this only to agents you fully trust and have reviewed.
- **Agents operate with your user permissions.** Anything the agent can do through Computer Use, you could do yourself at your keyboard. There is no privilege escalation, but there is also no additional sandboxing beyond the permission system.
- **Stop the agent to revoke all transient access.** Stopping an agent immediately releases any grabbed windows and clears all in-memory (once and timed) grants for that agent.

## Voice Input

SuperAgent supports voice input, allowing you to speak to your agents instead of typing. Voice messages are transcribed to text using a cloud speech-to-text (STT) provider, then sent as regular text messages to the agent. All voice settings are in **Settings > Voice**.

### Supported providers

| Provider | Model | Latency | Languages | Environment variable |
| --- | --- | --- | --- | --- |
| **Deepgram** | Nova 3 | ~200ms (lowest) | 47 | `DEEPGRAM_API_KEY` |
| **OpenAI** | GPT-4o Mini Transcribe / Whisper | Moderate | 57 | `OPENAI_API_KEY` |

A third option, **Platform**, is available when connected to the SuperAgent platform. It uses Deepgram Nova 3 via your platform connection and requires no separate API key.

### Setting up voice input

1. Open **Settings > Voice**.
2. Select a **Speech-to-Text Provider** from the dropdown.
3. Enter your API key for the selected provider (not needed for the Platform provider).
4. Click **Validate & Save**. SuperAgent will verify the key against the provider's API before saving.
5. Use the **Test** section to verify your microphone and transcription are working.

### Deepgram

[Deepgram](https://developers.deepgram.com/docs/models-languages-overview) provides the lowest-latency transcription using their Nova 3 model. SuperAgent connects to Deepgram's WebSocket API for real-time streaming transcription.

#### API key requirements

Your Deepgram API key must have at least **Member-level access** to create temporary (ephemeral) tokens. SuperAgent validates this during key setup by:

1. Checking that the key can access the Deepgram projects API.
2. Verifying the key can create ephemeral tokens via the `/v1/auth/grant` endpoint.

If your key passes the first check but fails the second, you will see: "API key is valid but lacks permission to create temporary tokens." Upgrade the key's access level in the [Deepgram Console](https://console.deepgram.com/).

#### How it works

When you start a voice recording:

1. SuperAgent requests a short-lived ephemeral token from Deepgram (valid for 10 minutes) using your stored API key. This token is passed to the browser -- your long-lived API key never leaves the server.
2. The browser opens a WebSocket connection to `wss://api.deepgram.com/v1/listen` with the ephemeral token.
3. Audio from your microphone is streamed in real time (16kHz, 16-bit linear PCM, mono).
4. Deepgram returns interim transcripts (displayed as you speak) and final transcripts (used as the message text).

Deepgram also supports batch transcription of audio files, which is used when audio data needs to be transcribed server-side rather than via the real-time WebSocket.

### OpenAI

[OpenAI](https://platform.openai.com/docs/guides/speech-to-text) provides transcription through their Whisper and GPT-4o Mini Transcribe models. SuperAgent uses OpenAI's Realtime API for streaming transcription in the browser.

#### API key requirements

A standard OpenAI API key is sufficient. SuperAgent validates the key by checking access to the OpenAI models endpoint.

#### How it works

When you start a voice recording:

1. SuperAgent requests a client secret from OpenAI's Realtime API (`/v1/realtime/client_secrets`) using your stored API key. This short-lived secret is passed to the browser.
2. The browser establishes a WebSocket connection to OpenAI's Realtime API using the client secret.
3. Audio is streamed and transcribed in real time, similar to Deepgram.

OpenAI also supports batch audio file transcription via the Whisper API (`/v1/audio/transcriptions`), used for server-side transcription of recorded audio.

### API key management

API keys for STT providers follow the same pattern as LLM provider keys:

- **Settings UI**: Enter the key in **Settings > Voice**. It is stored locally in `settings.json` with restricted file permissions.
- **Environment variables**: Set `DEEPGRAM_API_KEY` or `OPENAI_API_KEY` before starting SuperAgent. Saved keys take precedence over environment variables.

The current key status is displayed with a badge showing the source. You can remove a saved key to revert to the environment variable, or save a new key to override it.

### Voice input in the UI

Once voice input is configured, a microphone button appears in the message composer throughout the app. The workflow is:

1. Click the microphone button (or use the keyboard shortcut).
2. Grant microphone access if prompted by your browser.
3. Speak your message. Interim transcripts appear in real time as you talk.
4. Click the button again (or stop speaking) to finish recording.
5. The final transcript is placed into the message input, ready to send.

Voice input is available wherever you can type a message to an agent, including the main chat and the agent creation prompt.

### Voice Agent

Both Deepgram and OpenAI support **Voice Agent** sessions -- a more interactive mode where the agent can respond with voice as well. When a voice agent session is active, a separate token is minted for the voice agent endpoint. The availability of Voice Agent depends on whether the configured STT provider supports it (both Deepgram and OpenAI do).

### Troubleshooting

- **No microphone button visible**: Verify that a provider is selected and its API key is configured in **Settings > Voice**.
- **"API key lacks permission to create temporary tokens"** (Deepgram): Your key needs Member-level access. Check the key's permissions in the Deepgram Console.
- **"OpenAI API quota exceeded"**: Check your OpenAI account balance and billing settings at [platform.openai.com](https://platform.openai.com/).
- **Transcription is inaccurate**: Try speaking more clearly and reducing background noise. Ensure your microphone is working correctly using the test tool in **Settings > Voice > Test**.
- **Connection timeout**: The browser waits up to 10 seconds to connect to the STT provider's WebSocket. If this fails, check your network connection and try again.

## Usage and Costs

Superagent tracks every LLM API call your agents make and computes costs automatically. The usage dashboard in **Settings > Usage** gives you a daily breakdown of spending by agent and by model, so you can identify which agents consume the most tokens and where to optimize.

### What is tracked

Every time an agent sends a message to the Claude API, the response includes token usage metadata. Superagent records four token categories for each API call:

| Token type | Description |
|---|---|
| **Input tokens** | Tokens in the prompt sent to the model (user messages, system prompt, tool results) |
| **Output tokens** | Tokens generated by the model in its response |
| **Cache creation tokens** | Tokens written into the prompt cache on a cache miss |
| **Cache read tokens** | Tokens served from the prompt cache on a cache hit |

These counts are extracted from the Claude API response's `usage` object and written to JSONL session log files alongside each assistant message.

### How costs are calculated

Superagent calculates costs using per-million-token pricing for each Claude model. The pricing table covers all supported models:

| Model family | Input | Output | Cache creation | Cache read |
|---|---|---|---|---|
| Claude Opus 4.6 / 4.7 | $5.00 | $25.00 | $6.25 | $0.50 |
| Claude Opus 4.1 / 4 | $15.00 | $75.00 | $18.75 | $1.50 |
| Claude Sonnet 4.5 / 4.6 / 4 | $3.00 | $15.00 | $3.75 | $0.30 |
| Claude Haiku 4.5 | $1.00 | $5.00 | $1.25 | $0.10 |

All prices are per million tokens. The cost formula for a single API call is:

```
cost = (input_tokens * input_price
      + output_tokens * output_price
      + cache_creation_tokens * cache_creation_price
      + cache_read_tokens * cache_read_price) / 1,000,000
```

When a JSONL entry includes a `costUSD` field (provided by some proxy configurations), that value takes precedence over the calculated cost.

#### Model name normalization

Superagent normalizes model names from different providers before looking up pricing. This means usage from Bedrock (`us.anthropic.claude-opus-4-6-v1`), OpenRouter (`anthropic/claude-4.6-opus-20260205`), and the direct Anthropic API (`claude-opus-4-6`) all consolidate into a single entry in the usage chart.

### Daily aggregation

Usage data is aggregated by calendar day (in local timezone) across all session log files. For each day, Superagent computes:

- **Total cost** across all agents
- **Total tokens** (sum of all four token types)
- **Per-agent breakdown** with cost and token totals for each agent
- **Per-model breakdown** with cost for each model used that day

The aggregation scans JSONL files in each agent's Claude configuration directory. To avoid double-counting, entries are deduplicated by message ID and request ID, keeping only the snapshot with the highest output token count (since Claude streams partial usage updates as it generates a response).

#### Data retention

Usage data is derived from session log files, so it persists as long as those files exist. Deleting an agent removes its session logs and associated usage data. There is no separate database table for usage --- it is computed on the fly from the raw logs.

### The usage dashboard

The usage tab in **Settings** displays a stacked bar chart of daily costs. You can configure it with three controls:

#### Time range

Select from **Last 7 days**, **Last 14 days**, or **Last 30 days**. The API supports up to 90 days.

#### Segmentation

- **Total** --- A single bar per day showing aggregate cost.
- **By Model** --- Stacked bars colored by model, so you can see which models drive costs.
- **By Agent** --- Stacked bars colored by agent, so you can see which agents drive costs.

#### Scope (auth mode)

In [auth mode](https://www.gamut.so/docs/self-hosting/configuration/auth-mode), admins see a scope toggle:

- **My Agents** --- Only shows usage for agents the current user has access to.
- **All Agents** --- Shows usage across the entire deployment.

Non-admin users always see only their own agents' usage.

The chart displays a running total at the bottom right (e.g., "Total: $4.72").

### Context window tracking

In addition to cost tracking, Superagent monitors how much of each model's context window is being used during active sessions. Each session's metadata includes the latest context window usage percentage, calculated from the input token counts relative to the model's maximum context size.

The context percentage calculation handles both the old and new Anthropic API token counting formats:

- **New format**: `input_tokens` already includes cached tokens, so it is used directly.
- **Old format**: `input_tokens` counts only non-cached tokens, so cache creation and cache read tokens are added to get the total.

This percentage is displayed in the session sidebar, giving you a real-time sense of how close an agent is to its context limit.

### Optimizing agent costs

Use the usage dashboard to identify cost reduction opportunities:

- **Check model distribution.** Switch the segmentation to "By Model" to see if agents are using more expensive models than necessary. An agent handling simple tasks may not need Opus-tier models.
- **Review per-agent costs.** Switch to "By Agent" to find agents with disproportionately high costs. These may benefit from better prompts, more focused instructions, or lower-effort settings.
- **Monitor cache hit rates.** High cache creation costs with low cache read costs suggest that prompt caching is not being utilized effectively. Agents with stable system prompts and tool definitions benefit most from caching.
- **Watch context window usage.** Sessions that consistently approach 100% context utilization are likely hitting compaction (context summarization), which generates additional output tokens. Structuring tasks to complete within the context window avoids this overhead.
- **Use scheduled task model overrides.** Scheduled tasks accept an optional `model` parameter. You can configure recurring background tasks to use a less expensive model without changing the agent's default.

## Audit Logging

Superagent maintains three audit logs that together give you full visibility into what your agents are doing and what changes administrators have made. API proxy requests and MCP tool calls are logged per-agent. Administrative changes (creating agents, updating policies, managing users) are logged globally.

### API proxy audit log

Every HTTP request an agent makes through the API proxy is recorded in the `proxy_audit_log` table. This covers all calls to connected account APIs --- Gmail, GitHub, Slack, Salesforce, and every other provider.

Each entry captures:

| Field | Description |
|---|---|
| **Agent** | The agent slug that made the request |
| **Account** | The connected account ID used |
| **Toolkit** | The provider (e.g., `gmail`, `github`, `slack`) |
| **Target host** | The API hostname (e.g., `api.github.com`) |
| **Target path** | The request path (e.g., `repos/owner/repo/issues`) |
| **Method** | The HTTP method (`GET`, `POST`, `PUT`, `DELETE`, etc.) |
| **Status code** | The upstream API's response status code |
| **Policy decision** | How the request was authorized (see below) |
| **Matched scopes** | JSON array of OAuth scopes the request matched against |
| **Error message** | Set if the request failed at the proxy level (token validation failure, host not allowed, etc.) |
| **Timestamp** | When the request was made |

Audit entries are written for every request, including ones that are blocked or fail validation. This means you can see unauthorized access attempts, not just successful calls.

### MCP audit log

Requests proxied to remote MCP servers are recorded in the `mcp_audit_log` table. This covers all tool calls and protocol messages an agent sends through registered MCP servers.

Each entry captures:

| Field | Description |
|---|---|
| **Agent** | The agent slug that made the request |
| **MCP server** | The remote MCP server ID and name |
| **Method** | The HTTP method |
| **Request path** | The JSON-RPC method or HTTP path. For tool calls, this is formatted as `tools/call: tool_name` |
| **Status code** | The MCP server's response status code |
| **Duration** | Request duration in milliseconds |
| **Policy decision** | How the request was authorized |
| **Matched tool** | The specific tool name for `tools/call` requests |
| **Error message** | Set if the request failed |
| **Timestamp** | When the request was made |

Protocol-level MCP methods (handshake, tool discovery, pings) are always allowed without policy checks, but tool invocations go through the same policy enforcement as API proxy requests.

### Policy decisions

Both audit logs record the policy decision that governed each request. The possible values are:

| Decision | Meaning |
|---|---|
| `allow` | Automatically allowed by a scope policy, account default, or global default |
| `approved_by_user` | The request required review, and the user approved it |
| `block` | Automatically blocked by a scope policy |
| `denied_by_user` | The request required review, and the user denied it |
| `review_timeout` | The request required review, but the user did not respond in time |

Policy resolution follows a hierarchy. For API proxy requests:

1. **Scope policy** --- If the request matches a specific scope with an explicit policy, that policy applies.
2. **Account default** --- If no scope-specific policy exists, the account's default policy (the `*` scope) applies.
3. **Global default** --- If neither exists, the global default API policy from user settings applies.

When multiple scopes match a request, the most permissive decision wins. For MCP requests, the hierarchy is: explicit tool policy, then MCP default (`*`), then global default.

### Browsing the per-agent audit log

Each agent has an **API Logs** view accessible from the agent's home page. This view merges entries from both the proxy and MCP audit logs into a single chronological timeline.

The log table displays:

- **Timestamp** --- When the request was made, formatted as `MM/dd/yy, HH:mm:ss`
- **Duration** --- How long the request took (MCP requests only)
- **Source** --- Either "API" (proxy) or "MCP", shown as a colored badge
- **Method** --- The HTTP method, color-coded by verb
- **Status** --- The response status code, color-coded (green for 2xx, red for 4xx+)
- **Policy** --- The policy decision badge (auto-allowed, user-approved, auto-blocked, user-denied, or timeout)
- **Toolkit** --- The provider name or MCP server name
- **Path** --- The target URL or request path, with error messages shown inline in red

Click any row to expand a detail panel showing the full path, source type, matched scopes, duration, error details, and precise timestamp.

The view is paginated (15 entries per page) with a refresh button to load the latest entries.

### Administrative audit log

The global **Audit Log** tab in **Settings** tracks administrative actions across the deployment. This is separate from the per-agent API/MCP logs and records changes to the system's configuration.

#### Tracked objects and actions

| Object | Actions |
|---|---|
| **agent** | created, updated, deleted, imported, exported |
| **agent_access** | granted, revoked, changed |
| **account** | connected, disconnected, assigned, unassigned |
| **mcp** | created, updated, deleted, assigned, unassigned |
| **trigger** | created, updated, deleted, paused, resumed |
| **task** | created, updated, deleted, paused, resumed |
| **chat_integration** | created, updated, deleted |
| **skill** | created, updated, exported |
| **secret** | created, updated, deleted |
| **file** | uploaded |
| **mount** | created, deleted |
| **settings** | updated, factory_reset |
| **policy** | updated |
| **user** | invited, reset_password |

Each entry records the timestamp, the user who performed the action (in auth mode), the object type, the action, the object ID (e.g., the agent slug or account ID), and an optional details field with additional context as a JSON object.

#### Filtering

The audit log UI provides three filter dropdowns:

- **Object** --- Filter by object type (agent, account, mcp, trigger, etc.)
- **Action** --- Filter by action. The available actions update based on the selected object type.
- **User** --- Filter by the user who performed the action. Only available in auth mode.

The log is paginated (25 entries per page) and sorted by timestamp, newest first.

#### Auth mode

The administrative audit log is restricted to admin users. The API endpoint (`/api/audit-log`) requires both authentication and admin role. In auth mode, each audit entry includes the user ID of the person who performed the action, and the User filter column appears in the table with user names and email tooltips.

## Notifications

Superagent sends notifications when agents need your attention or when automated tasks fire. Notifications appear as OS-level alerts (desktop banners or browser notifications) and are also stored in an in-app notification center with read/unread tracking.

### Notification types

There are five notification types, each triggered by a different kind of agent event:

#### Session complete

Triggered when an agent finishes running a session. The notification reads something like "Research Agent has finished running". This type is suppressed for automated sessions (scheduled tasks, webhook triggers, and chat integrations) since those are not user-initiated and would create noise.

#### Session waiting (action required)

Triggered when an agent is blocked and needs user input. This is the most important notification type because the agent cannot continue without you. The waiting reason is included in the notification body:

| Waiting reason | Notification body |
|---|---|
| Secret needed | "Agent name needs a secret value" |
| Account access needed | "Agent name needs account access" |
| Question for user | "Agent name has a question for you" |
| File needed | "Agent name needs a file from you" |
| MCP server access | "Agent name needs access to an MCP server" |
| Browser input | "Agent name needs your browser input" |
| Script approval | "Agent name wants to run a script on your machine" |
| Computer use | "Agent name wants to control your computer" |

A special variant of this type is the **API request review** notification. When an agent makes an API call that requires user approval (based on [scope policies](https://www.gamut.so/docs/using-superagent/integrations/scope-policies)), the notification includes Approve and Deny action buttons on macOS. Clicking a button submits the review decision without needing to open the app.

#### Session scheduled

Triggered when a scheduled task starts a new session. The notification reads something like "Daily report started for Research Agent".

#### Session webhook

Triggered when a webhook trigger fires and starts a new session. The notification reads something like "GitHub push trigger fired for DevOps Agent".

#### Session chat integration

Triggered for chat integration lifecycle events (connected, disconnected, or error). These are informational and do not require user action.

### User-actionable vs. informational

Superagent distinguishes between actionable and informational notifications for badge counting:

- **Actionable**: `session_complete` and `session_waiting`. These contribute to the unread count badge and the sidebar's unread indicators.
- **Informational**: `session_scheduled`, `session_webhook`, and `session_chat_integration`. These appear in the notification history but do not increment the unread badge.

This distinction prevents automated events from creating a false sense of urgency. A webhook that fires 50 times a day should not bury the one notification where an agent actually needs your help.

### The notification center

The notification center is a dedicated view accessible from the sidebar. It shows a chronological list of all notifications with:

- **Agent name** and slug suffix for identification
- **Title** and **body** text summarizing the event
- **Timestamp** in a relative format (e.g., "2:30 pm" for today, "yesterday", "May 12" for older)
- **Unread indicator** as a blue dot on the left edge

Clicking a notification navigates you to the relevant session (or to the agent home for chat integration events) and automatically marks it as read.

#### Bulk actions

A **Mark all as read** button at the top clears all unread indicators at once. This is useful after reviewing a backlog of notifications.

#### Session-level read tracking

When you open a session, all notifications for that session are automatically marked as read. This means you do not need to manually dismiss individual notifications for a session you are already looking at.

#### Pagination

The notification center is paginated (15 items per page) with total count displayed. Older notifications beyond the current page are still accessible through pagination controls.

### Notification settings

Notification preferences are configured in **Settings > Notifications**. Each user has independent settings.

#### Global toggle

The master **Enable Notifications** switch controls whether any notifications are shown. When disabled, no OS notifications or in-app notifications are created.

#### Per-type toggles

When the global toggle is on, you can individually enable or disable:

- **Session Complete** --- When an agent finishes running
- **Action Required** --- When an agent needs input (secrets, account access, API review)
- **Scheduled Task Started** --- When a scheduled task begins running

#### Browser permission

In the web interface (non-Electron), browser notification permission is required for OS-level alerts. If permission has not been granted, the settings page shows a prompt to request it. If permission was denied in the browser, the settings page explains how to re-enable it in browser settings.

#### Test notification

A **Send Test** button lets you verify that notifications are working. In the Electron app, this also triggers the macOS notification permission prompt if it has not been shown yet.

### OS notification delivery

Superagent delivers OS notifications differently depending on the runtime:

#### Electron (desktop app)

Uses Electron's native notification API, which supports macOS notification actions (Approve/Deny buttons for API reviews). The dock badge count is synced with the unread notification count. Notifications that arrive while the renderer is not loaded are queued and replayed when the window opens.

#### Web browser

Uses the standard Web Notifications API. Action buttons are not supported in web notifications --- clicking the notification focuses the browser window and navigates to the relevant session. Notifications are only shown if the user has granted browser notification permission.

#### Smart suppression

Notifications are suppressed when you are already looking at the relevant session. The specific suppression logic differs by notification type:

- **Action-required notifications** (`session_waiting`) are only suppressed if both the tab is visible and the window has focus. This ensures you still get alerted if the app is visible but you are working in another application.
- **All other notifications** are suppressed whenever the tab is visible, even if the window is not focused. This avoids unnecessary interruptions for informational events.

### Auth mode behavior

In [auth mode](https://www.gamut.so/docs/self-hosting/configuration/auth-mode), notifications are scoped to the agents each user has access to:

- Users only see notifications for agents they have been granted access to (via agent ACLs).
- The unread count badge reflects only notifications for accessible agents.
- The SSE notification stream filters events by agent access, so users never receive real-time events for agents they cannot see.
- Admins are not exempt from scoping --- they see notifications for agents explicitly shared with them, matching the agent list behavior.

Notification settings are per-user. In non-auth mode, a single set of settings controls notification behavior for all sessions. In auth mode, the server always creates the notification (since settings are per-client), and each connected client independently checks its own user's preferences before showing the OS alert.

### Data retention

Notifications older than 30 days are automatically cleaned up. The cleanup runs periodically and removes both read and unread notifications past the retention window.
