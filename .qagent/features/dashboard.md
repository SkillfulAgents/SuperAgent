# Dashboard

This feature covers dashboard creation via chat, sidebar listing, dashboard viewing, and dashboard deletion.

## Prerequisites

- Agent chat is available.

## Sidebar - Dashboard Items

### Components
- **Dashboard entry** - child node under the parent agent.
- **Expand/collapse control** - reveals dashboards under the agent node.

### Interactions
- Expand agent node to view dashboards.
- Click dashboard entry to open it.
- Right-click dashboard entry to open context menu.

## Main Content - Dashboard View

### Components
- **Dashboard iframe** - renders dashboard output in main content area.

### Interactions
- Open dashboard from sidebar and verify iframe content loads.

## Chat View - Dashboard Creation

### Components
- **`create_dashboard` tool call card** - shows tool invocation and result.
- **Assistant confirmation message** - reports creation result.

### Interactions
- Ask agent to create a dashboard.
- Verify tool call appears and new dashboard entry is added to sidebar.

## Sidebar - Dashboard Deletion

### Components
- **Delete Dashboard context action** - removes selected dashboard.
- **Delete confirmation dialog** - confirms deletion.

### Interactions
- Delete dashboard from context menu.
- Confirm deletion and verify dashboard entry is removed.

