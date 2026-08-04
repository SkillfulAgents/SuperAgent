---
title: How does the agent container work?
description: Container anatomy for debugging — filesystem layout, what persists, injected environment variables, baked-in assets, and common failure shapes.
---

Reference for the agent (and curious users) about the runtime it lives in. Read this when something fails in a way that smells like the harness rather than the task: a missing environment variable, a path that "should" exist, a port conflict, files disappearing.

## Filesystem layout

| Path | What it is | Writable? |
| --- | --- | --- |
| `/workspace` | The agent's persistent home: all durable work belongs here | yes |
| `/workspace/CLAUDE.md` | Standing instructions, auto-prepended to the system prompt each session | yes |
| `/workspace/.claude/` | Claude config dir (`CLAUDE_CONFIG_DIR`): settings, skills, session transcripts, memory | yes |
| `/workspace/.claude/skills/` | The agent's own skills | yes |
| `/workspace/.env` | Per-agent secrets, injected as env vars and via `--env-file` | yes |
| `/workspace/uploads/` | Files the user attaches in chat land here | yes |
| `/workspace/downloads/` | Browser downloads land here | yes |
| `/workspace/bookmarks.json` | Bookmarks shown on the agent homepage | yes |
| `/workspace/.browser-profile` | Browser profile (cookies, sessions) | yes |
| `/app` | The container's own server code — not the agent's code | no (don't touch) |
| `/home/claude/.claude/skills/` | Image-baked skills (e.g. dashboard templates) | no |
| `/opt/gamut/docs` | This documentation — baked into the image, read-only | no |
| `/opt/playwright-browsers` | Chromium install shared by the browser and dashboard screenshots | no |

Only `/workspace` is the agent's own durable storage — it is a mounted volume that survives container restarts, sleeps, and image upgrades. Everything else is part of the image and is reset whenever the image is upgraded. The process runs as the non-root user `claude`; root-owned paths are intentionally not writable.

## Process model

- The container runs a small HTTP server (port 3000) that the host app talks to: it manages sessions, streams responses over WebSocket, serves the `/files/*` API for the workspace file browser (rooted at `/workspace` — which is why this docs folder does not appear there), and exposes `/health`.
- The agent itself is Claude Code running headless via the Agent SDK; `claude` is also on `PATH` for shell use.
- Sessions persist as JSONL transcripts under the Claude config dir; the host keeps its own session metadata, which is why history survives container sleeps.

## Available runtimes and languages

Node.js 22, Python 3.11 (prefer `uv run --env-file .env`), TypeScript (`tsc`, `ts-node`), Bun (used to serve dashboards), plus standard Unix tooling, `git`, `jq`, and network utilities. The browser is driven through the dedicated browser tools, not by launching Chromium by hand.

## Environment variables injected by the host

Set at container start — a change made in settings mid-session may require the container to restart before it appears:

- `CONNECTED_ACCOUNTS` — JSON map of toolkit → connected accounts (name + id)
- `PROXY_BASE_URL`, `PROXY_TOKEN` — the authenticated proxy for connected-account API calls
- `REMOTE_MCPS` — configured remote MCP servers
- `CLAUDE_CONFIG_DIR=/workspace/.claude`, `HOME=/home/claude`, `TZ`, plus every secret from `/workspace/.env`

## Common failure shapes

- **"Secret/account should exist but the env var is missing"** — it was likely added after this container started; ask the user to retry in a fresh session, which restarts with fresh env.
- **A port is already in use** — usually a previous dashboard or dev server still running; list processes before killing anything.
- **"Read-only file system" / permission denied outside `/workspace`** — by design; put files in `/workspace`.
- **Something outside `/workspace` you created earlier is gone** — the image was upgraded; only `/workspace` persists. Recreate it there.
