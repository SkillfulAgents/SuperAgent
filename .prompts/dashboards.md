I want to allow agents to create dashboards that visualize data / provide interactive elements

## Container Setup

- We will add `bun` to the container to support running a simple web server for dashboards

## Dashboard Structure

- Dashboards are defined in `/workspace/artifacts/<slug>/` directories (under the workspace so they persist across container restarts)
    - Each dashboard shall be a javascript/typescript app using a framework like React, Svelte, or plain JS
    - It must have a `package.json` defining dependencies and a start script to run the dashboard server
    - The `package.json` shall have `name` and `description` fields to describe the dashboard
    - The agent can create multiple dashboards by creating multiple directories under `/workspace/artifacts/`
    - Scripts must always listen on a port provided via the `DASHBOARD_PORT` env var

## Dashboard Lifecycle & Process Management

- When the container starts, we will scan the `/workspace/artifacts/` directory for dashboards, and for each one:
    - Execute `bun install && DASHBOARD_PORT=<port> bun run start` to install dependencies and start the dashboard server
    - Pipe stdout/stderr from the dashboard server to `/workspace/artifacts/<slug>/dashboard.log` so the agent can inspect logs if needed
    - Each dashboard server should listen on a different port (assign ports starting from a base port, e.g., 4000, 4001, etc.)
- Dashboard startup happens **asynchronously after container start** — it should not block the container health check or agent readiness
- **Crash handling**: If a dashboard process exits, automatically restart it (with a backoff/limit, e.g., max 3 restarts within 5 minutes). After exhausting retries, leave it stopped — the agent can manually restart via the RestartDashboard tool.

## Container API

- The container API will expose a new endpoint `/artifacts/<slug>/*` that proxies requests to the corresponding dashboard server
    - For example, a request to `/artifacts/sales-dashboard/` will be proxied to the sales-dashboard server running on its assigned port
- Expose `GET /artifacts` endpoint that returns dashboard metadata for all dashboards:
    - `[{slug, name, description, status, port}]`
    - `status` can be: `running`, `stopped`, `crashed`, `starting`
    - This is used by the main app when the container is running

## Main App UI

- In the main app, under each agent in the left nav, if it has artifacts, we will show an item for each — with a dashboard icon and the name from `package.json`
    - Clicking it will open the dashboard view — an iframe that loads the dashboard from the container API endpoint (proxied through the main app server → container API → dashboard server)
    - If the agent is sleeping / stopped, show a message indicating the dashboard is not available, with a button to start the agent
- For listing dashboards when the container is off, the API can directly read the workspace artifacts directory on the host and parse `package.json` files to get names/descriptions

## Agent Tools

- Merge StartDashboard and RestartDashboard into a single tool: **StartDashboard** — starts the dashboard server, or restarts it if already running. Used when creating a new dashboard or after code changes.
- Provide a **CreateDashboard** scaffolding tool that generates the correct directory structure, `package.json` template with `DASHBOARD_PORT` boilerplate, and a starter `index.js`. This reduces misconfiguration.
- Full tool list:
    - **CreateDashboard** — scaffold a new dashboard project at `/workspace/artifacts/<slug>/` with correct structure and boilerplate
    - **StartDashboard** — start (or restart if already running) a dashboard server
    - **ListDashboards** — list all dashboards created by the agent (reads from `/workspace/artifacts/`)
    - **GetDashboardLogs** — get the logs from a dashboard server (reads from `/workspace/artifacts/<slug>/dashboard.log`), with an optional `clear` flag to truncate logs after reading

## Agent Instructions (Skill)

- Create a system-level skill in the container's `~/.claude/skills/` directory (baked into the container image). Since the SDK uses `settingSources: ['user', 'project']`, user-level skills from `~/.claude/` are discovered alongside workspace-level skills.
- The skill should describe:
    - How to create dashboards (directory structure, `package.json` requirements, `DASHBOARD_PORT` usage)
    - Examples of simple dashboards (plain HTML+JS, React)
    - Documentation of the available dashboard tools
    - Best practices (keep dependencies minimal, use `bun` APIs, handle the port env var)

## URL Proxying & Relative Paths

Dashboards are served through a multi-level proxy: **Browser → Main App (`/api/agents/:id/artifacts/:slug/`) → Container (`/artifacts/:slug/`) → Dashboard Server (`/`)**.

- **Dashboard code must use relative URLs** (e.g., `fetch('api/data')`, not `fetch('/api/data')`)
- Absolute paths (starting with `/`) resolve against the main app's origin, bypassing the proxy chain entirely
- This applies to all fetches, image sources, script/link tags, etc.
- React dashboards use `vite build` to produce static assets (with relative paths) served by a `Bun.serve()` static server — Vite's dev server cannot be used because its HMR and module URLs don't work through the proxy chain

## Key Design Decisions

- **No new DB table needed** — dashboard metadata lives in the filesystem (`package.json` files)
- **No container required to list dashboards** — main app reads the workspace artifacts directory directly from the host
- **Dashboards are just web servers** — no special runtime, just a `package.json` with a start script that listens on `DASHBOARD_PORT`
- **React dashboards build to static** — Vite dev server doesn't work through the proxy chain, so React dashboards run `vite build` and serve the output with a static Bun server (`serve.js`) that also supports API routes
