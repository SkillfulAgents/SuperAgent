# Dashboard

## Overview

Dashboards are created by the agent through chat conversation using the `create_dashboard` tool — there is no dedicated settings UI for creating them. The agent writes code and sets up the dashboard as part of a chat interaction.

## Sidebar — Dashboard Items

Dashboards appear as **sub-items** under their parent agent in the sidebar tree.

### Components

- **Dashboard entry** — each created dashboard is listed as a child node beneath the agent that created it.
- **Expand/collapse** — the agent's tree node can be expanded to reveal its dashboards.

### User Interactions

- Click a dashboard entry to open it in the main content area.
- Right-click a dashboard entry to open the **context menu**.

## Dashboard View

When a dashboard is selected, the main content area displays the dashboard inside an **iframe** that renders the dashboard's content.

### Components

- **Dashboard iframe** — renders the dashboard code/content produced by the agent. Loads automatically when the dashboard is opened.

## Dashboard Creation via Chat

Users ask the agent to create a dashboard by sending a message in the chat. The agent processes the request, writes the necessary code, and invokes the `create_dashboard` tool.

### Components

- **Tool call card** — a `create_dashboard` card appears in the message list showing the tool invocation and result.
- **Agent response** — the agent confirms whether the dashboard was created successfully.

### Behavior

- After creation, the new dashboard appears in the sidebar under the agent.
- Processing may take some time as the agent generates code and provisions the dashboard.

## Dashboard Context Menu

Right-clicking a dashboard entry in the sidebar opens a context menu.

### Actions

- **Delete Dashboard** — removes the dashboard. A confirmation dialog appears before the deletion is executed. Once confirmed, the dashboard entry is removed from the sidebar.
