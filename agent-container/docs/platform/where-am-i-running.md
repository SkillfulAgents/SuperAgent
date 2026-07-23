---
title: Where is the agent running?
description: The runtime environments (desktop Docker/Lima/Apple container, cloud MicroVM), what persists across sleeps and upgrades, and lifecycle behavior.
---

The same container image runs in several environments. The agent usually does not need to care which one it is in — but lifecycle behavior (sleep, persistence, networking) differs in ways that matter for debugging and for setting user expectations.

## The runtimes

- **Self-hosted desktop (macOS app)**: the container runs locally via Docker Desktop, Lima, or Apple's container runtime — whichever the user configured. Data stays on the user's machine.
- **Self-hosted server (Docker)**: same image on a server the user administers.
- **Cloud / managed**: the container runs as a Lambda MicroVM in the managed environment.

In every case each agent gets its own container instance and its own `/workspace` volume.

## Lifecycle: sleep and wake

Idle agents are put to sleep to save resources and are woken automatically when a message, scheduled task, or webhook arrives. Practical consequences:

- **Do not rely on long-running background processes** surviving between conversations (watchers, `while true` loops, servers you started ad hoc). For "keep an eye on X" requests, use scheduled tasks or webhook triggers instead — they wake the agent properly. Dashboards are managed by the platform and are restarted for you.
- In-flight shell state (env exports, cwd, tmux-style sessions) does not survive a sleep. Durable state belongs in `/workspace` files.

## What persists where

| Layer | Survives restart/sleep | Survives image upgrade |
| --- | --- | --- |
| `/workspace` (files, skills, memory, secrets, CLAUDE.md, browser profile) | yes | yes |
| Session history/transcripts | yes | yes |
| Anything outside `/workspace` (e.g. `/tmp`, apt/npm installs into the image) | usually | **no** |
| Running processes | no | no |

If a tool or package needs to survive long-term, install/copy it under `/workspace` (e.g. a project-local `node_modules` or `uv` environment) rather than into system paths.

## Networking

- Outbound internet access is available for code and the browser (managed deployments may restrict egress).
- Inbound traffic does not reach the container directly: users reach dashboards through platform-managed URLs, and webhooks arrive via platform webhook endpoints that start sessions — the agent cannot just `listen()` on a port and receive public traffic.
- Connected-account API calls must go through `$PROXY_BASE_URL` (see [connect-external-accounts-oauth](../how-to/connect-external-accounts-oauth.md)); calling those providers directly will fail for lack of credentials.

## Time

The container's timezone comes from the `TZ` env var set by the host from user settings. Scheduled-task cron expressions are evaluated against that timezone; when discussing times with the user, `date` in the shell reflects it.
