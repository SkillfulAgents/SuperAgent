---
title: How do dashboards and artifacts work?
description: Apps the agent builds for you: dashboards (live web apps) and artifacts, and how to view and manage them.
source_url:
  - https://www.gamut.so/docs/using-superagent/apps/overview
  - https://www.gamut.so/docs/using-superagent/apps/dashboards
  - https://www.gamut.so/docs/using-superagent/apps/artifacts
---

## Apps Overview

When agents work in Superagent, they can produce two kinds of outputs that persist beyond individual chat sessions: **dashboards** and **artifacts**. Together, these form the "Apps" layer of the platform.

### Dashboards

Dashboards are interactive web applications that agents create and serve. An agent can build a full HTML/JavaScript interface -- a data visualization, a control panel, a monitoring page -- and make it available as a live, always-accessible view inside Superagent.

Dashboards appear in the sidebar alongside the agent's sessions. They are identified by a unique slug and remain available as long as the agent exists. When you open a dashboard, the agent automatically starts if it is not already running.

Key characteristics:

- **Agent-created** -- Agents build dashboards using the `create_dashboard` MCP tool during a session.
- **Interactive** -- Dashboards are full HTML/JS applications rendered in an iframe with access to scripts, forms, and popups.
- **Persistent** -- Once created, a dashboard survives across sessions and agent restarts. Its files are stored on the host filesystem.
- **Live** -- Dashboards are served by the agent's container process. The agent must be running for the dashboard to be live, but Superagent handles auto-starting transparently.

See [Dashboards](https://www.gamut.so/docs/using-superagent/apps/dashboards) for details on creation, access, and management.

### Artifacts

Artifacts are files that agents deliver to the user during a session. When an agent generates a report, exports data, or produces any downloadable output, it uses the `deliver_file` tool to hand that file to the user.

Unlike dashboards, artifacts are tied to the session where they were created. They appear inline in the conversation as downloadable pills.

Key characteristics:

- **Session-scoped** -- A delivered file appears in the message thread where the agent produced it.
- **Downloadable** -- Each delivered file is available for immediate download from the conversation view.
- **Non-blocking** -- File delivery resolves immediately; it does not pause the agent waiting for user input.

See [Artifacts](https://www.gamut.so/docs/using-superagent/apps/artifacts) for details on how file delivery works and how to access delivered files.

### How They Relate

Dashboards and artifacts serve different purposes:

| | Dashboards | Artifacts |
|---|---|---|
| **Nature** | Live interactive web apps | Static delivered files |
| **Lifetime** | Persist across sessions | Tied to the session that produced them |
| **Access** | Sidebar link, standalone URL, Dock shortcut | Download link in conversation |
| **Agent state** | Agent must be running to view | Available anytime (files stored on host) |
| **Use cases** | Monitoring views, control panels, data explorers | Reports, exports, generated documents |

An agent might use both in a single workflow -- for example, building a live analytics dashboard while also delivering a CSV export of the underlying data as an artifact.

## Dashboards

Dashboards are interactive web applications that agents build and serve. They let an agent go beyond text-based conversations and provide a persistent, visual interface -- a monitoring view, a data explorer, a control panel -- that users can access at any time.

### How Agents Create Dashboards

Agents create dashboards using MCP tools exposed by the `dashboards` MCP server. The primary tool is `create_dashboard`.

#### create_dashboard

Creates a new dashboard project in the agent's workspace. The tool accepts the following parameters:

- **slug** -- A URL-safe identifier for the dashboard (e.g. `sales-metrics`). Used in routing and filesystem paths.
- **name** -- A human-readable display name shown in the sidebar and header bar.
- **description** -- A short description of what the dashboard does.
- **framework** -- Either `plain` (static HTML/JS) or `react` (a React-based app).

When the agent calls `create_dashboard`, Superagent scaffolds a project in the agent's `artifacts/` directory, installs dependencies, and starts a dev server. The dashboard becomes immediately available.

#### start_dashboard

Starts (or restarts) a previously created dashboard by its slug. Useful after code changes or if the dashboard process crashed.

#### list_dashboards

Returns all dashboards for the current agent, including their status (`running`, `stopped`, `crashed`, `starting`), port, and metadata.

#### get_dashboard_logs

Retrieves the console output from a dashboard's dev server process. Agents use this to debug build errors or runtime issues. Accepts an optional `clear` parameter to reset the log buffer after reading.

### What Dashboards Can Contain

A dashboard is a full web application. Agents can build anything that runs in an HTML/JS environment:

- Data visualizations and charts
- Interactive forms and controls
- Real-time monitoring interfaces
- Multi-page applications (when using the React framework)

Dashboards run inside a sandboxed iframe with `allow-scripts`, `allow-same-origin`, `allow-forms`, and `allow-popups` permissions, plus microphone and camera access. Superagent also injects polyfills that give the dashboard access to browser APIs and an LLM SDK, enabling AI-powered interactive features within the dashboard itself.

### Accessing Dashboards

There are several ways to open a dashboard.

#### Sidebar Navigation

When you expand an agent in the sidebar, its dashboards appear at the top of the submenu, marked with a pointer icon. Click a dashboard to open it in the main content area. Double-click to open it in a new window.

#### Home Page Cards

The home page shows dashboard cards alongside agent cards in the grid. Each card displays a screenshot thumbnail (when available) and opens the dashboard on click.

#### Agent Home View

When you select an agent and land on its home view, dashboard cards appear in the right column. These provide quick access without needing to expand the sidebar submenu.

#### Standalone URL

Every dashboard has a standalone view URL at:

```
/api/agents/{agentSlug}/artifacts/{dashboardSlug}/view
```

This page is self-contained: it checks the agent's status, auto-starts it if needed, waits for the dashboard to become available, then displays it in a full-viewport iframe. You can share this URL or bookmark it.

#### Pop-out Window

In the Electron desktop app, the dashboard toolbar includes an "Open in new window" button that launches the dashboard in a dedicated window. On the web, this opens a new browser tab with the standalone view.

#### macOS Dock Shortcut

On macOS, the dashboard toolbar includes an "Add to Dock" button. This opens a dialog where you can choose an icon emoji and background color, then creates a macOS dock shortcut that launches the dashboard directly. The shortcut auto-starts the agent and waits for the dashboard, providing a native-app-like experience.

### The Dashboard Panel

When you open a dashboard inside Superagent, it renders in a panel with a toolbar at the top. The toolbar shows:

- The dashboard name and description
- An "Add to Dock" button (macOS Electron only)
- An "Open in new window" button
- A "Refresh" button to reload the iframe

Below the toolbar, any pending approval requests from the agent appear as inline review prompts. This means you can approve or deny agent actions (like API calls that require user consent) directly from the dashboard view without switching to a chat session.

### Dashboard Lifecycle

Dashboards are tied to their agent's container lifecycle:

1. **Creation** -- The agent calls `create_dashboard`, which scaffolds the project and starts the dev server.
2. **Running** -- While the agent's container is running, the dashboard process serves content on an internal port. Superagent proxies requests from the UI to this port.
3. **Stopped** -- When the agent stops, the dashboard process stops too. The dashboard files remain on disk.
4. **Auto-start** -- When you navigate to a stopped dashboard (via the sidebar, a URL, or a Dock shortcut), Superagent automatically starts the agent. The UI shows a loading state until the dashboard is ready.

Dashboard status values are `running`, `stopped`, `crashed`, and `starting`. The UI polls rapidly (every second) when any dashboard is in the `starting` state, then slows to a 60-second interval once all dashboards are stable.

### Managing Dashboards

#### Renaming

Right-click a dashboard in the sidebar and select "Rename Dashboard" to edit its display name inline. The name is stored in the dashboard's `package.json` on the host filesystem.

#### Deleting

Right-click a dashboard in the sidebar and select "Delete Dashboard" to permanently remove it. This stops the dashboard process (if running) and deletes all of its files. The action cannot be undone.

#### Screenshots

Superagent automatically captures a screenshot of each dashboard. This thumbnail is displayed on dashboard cards in the home page and agent home view. Screenshots are stored as `screenshot.png` inside each dashboard's directory and are served directly from the host filesystem, so they remain available even when the agent is stopped.

## Artifacts

Artifacts are files that agents deliver to users during a conversation. When an agent generates a report, creates a dataset export, builds an image, or produces any other file output, it uses the `deliver_file` tool to hand that file to you directly in the chat.

### The deliver_file Tool

Agents deliver files through the `mcp__user-input__deliver_file` MCP tool, which is part of the built-in `user-input` MCP server available to every agent. The tool accepts two parameters:

- **filePath** -- The path to the file inside the agent's workspace (e.g. `/workspace/output/report.pdf`).
- **description** -- An optional description of what the file contains.

File delivery is non-blocking. Unlike tools that request user input (such as `request_secret` or `request_file`), `deliver_file` resolves immediately and the agent continues its work without waiting for acknowledgment. This means an agent can deliver multiple files in sequence without pausing.

### How Delivery Appears in the UI

When an agent delivers a file, it shows up in the session's message thread in two forms:

#### Collapsed View

In the default collapsed state, the tool call appears as a compact row labeled "Deliver File" with a download pill next to it. The pill shows the filename with a file-type icon and a download button. You can click the pill to download the file directly without expanding the message.

#### Expanded View

Clicking the tool row expands it to show:

- The file description (if provided)
- The filename with its type icon
- A "Download" button
- The tool result (success or error status)

#### Streaming View

While the agent is still in the process of calling the tool, you see a "Preparing file..." or "Delivering: filename" message, depending on how much of the tool input has been streamed.

### Accessing Delivered Files

Delivered files are served from the agent's workspace on the host filesystem. When you click a download link, the browser fetches the file from:

```
/api/agents/{agentSlug}/files/{relativePath}
```

The file is served as a download (with `Content-Disposition: attachment`), so your browser will save it to your downloads folder. Files are path-traversal protected -- the server ensures that the requested path stays within the agent's workspace directory.

Files remain available as long as the agent exists and the file has not been deleted from the workspace. Unlike dashboards, file downloads do not require the agent to be running -- the files are read directly from the host filesystem.

### deliver_session

In addition to `deliver_file`, agents have access to a `deliver_session` tool (`mcp__user-input__deliver_session`). This is used in multi-agent workflows where one agent hands off a completed session transcript to another. It accepts:

- **session_id** -- The ID of the session to deliver.
- **agent_slug** -- The slug of the agent that owns the session.
- **description** -- An optional description of the session contents.

This tool is primarily used by the cross-agent orchestration system and appears in the conversation as an inline session reference.

### Relationship to Dashboards

While both dashboards and artifacts live in the agent's workspace, they serve different purposes:

- **Artifacts** are point-in-time file deliveries. The agent creates a file, hands it to you, and moves on. You get a downloadable snapshot.
- **Dashboards** are live, interactive applications that the agent builds and serves. They update in real time and persist across sessions.

An agent might use both together -- for example, building a live metrics dashboard while also delivering a weekly PDF summary as an artifact. The dashboard provides an interactive view; the artifact provides a portable, shareable document.
