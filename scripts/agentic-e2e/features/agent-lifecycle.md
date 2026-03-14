# Agent Lifecycle

Controls for managing an agent's running state live in the agent header. Deletion is accessed through the sidebar.

## Status Indicator

Located in the agent header. Displays the agent's current state:

- **Sleeping** — moon icon, gray. The container is stopped.
- **Starting** — transitional state while the container boots.
- **Running / Idle** — the container is active and ready.

## Start / Stop Controls

**Components:**
- Start button — visible in the agent header when the agent is sleeping
- Stop button — visible in the agent header when the agent is running/idle; also accessible via the settings button (data-testid='agent-settings-button')

**User interactions:** Users can stop a running agent; the status transitions to "sleeping" (typically 5–15 seconds). Users can start a sleeping agent; the status transitions through "starting" to "running" or "idle" (typically 30–120 seconds).

## Session Persistence

Sessions created before a stop/start cycle are preserved. After restarting an agent, previously created sessions remain visible in the sidebar session list beneath the agent.

## Agent Deletion

**Components:**
- Sidebar context menu — triggered by right-clicking the agent entry in the sidebar; contains a "Delete Agent" item (data-testid='delete-agent-item')
- Confirmation dialog (data-testid='confirm-delete-agent-dialog') — includes a Delete button (data-testid='confirm-delete-agent-button')

**User interactions:** Users can right-click an agent in the sidebar and select "Delete Agent." A confirmation dialog appears; confirming deletes the agent and removes it from the sidebar entirely.
