# Agent Lifecycle

This feature covers runtime state transitions, start/stop controls, session persistence, and agent deletion.

## Prerequisites

- At least one agent exists.

## Agent Header - Status Indicator

### Components
- **Status indicator** - displays `sleeping`, `starting`, `running`, or `idle`.

### Interactions
- Verify status reflects container state after start/stop actions.

## Agent Header - Start and Stop

### Components
- **Start button** - visible when status is `sleeping`.
- **Stop button** - visible when status is `running` or `idle`.
- **Agent settings button** (`data-testid='agent-settings-button'`) - alternate access path for stop action.

### Interactions
- Stop a running agent and verify transition to `sleeping`.
- Start a sleeping agent and verify transition through `starting` to `running` or `idle`.

## Sidebar - Session Persistence

### Components
- **Session list under agent** - historical sessions linked to the agent.

### Interactions
- Create sessions before a stop/start cycle.
- Restart the agent.
- Verify previous sessions remain visible.

## Sidebar - Agent Deletion

### Components
- **Delete Agent menu item** (`data-testid='delete-agent-item'`) - available in sidebar context menu.
- **Delete confirmation dialog** (`data-testid='confirm-delete-agent-dialog'`) - confirms delete.
- **Confirm Delete button** (`data-testid='confirm-delete-agent-button'`) - executes delete.

### Interactions
- Right-click an agent and choose Delete Agent.
- Confirm deletion and verify the entry is fully removed.

