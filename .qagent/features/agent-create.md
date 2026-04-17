# Agent Create

This feature covers creating an agent, starting its container, and deleting it from the sidebar.

## Prerequisites

- The app is loaded and the sidebar is visible.

## Sidebar - Create Agent

### Components
- **Create Agent button** (`data-testid='create-agent-button'`) - opens the creation screen.
- **Create Agent screen** (`data-testid='create-agent-screen'`) - full-screen takeover for new agent creation.
- **Prompt composer** (`data-testid='create-agent-prompt'`) - textarea for the agent's first instruction; name is auto-generated from the prompt.
- **Submit button** (`data-testid='create-agent-submit'`) - confirms creation.
- **Close button** (`data-testid='create-agent-close'`) - dismisses the screen.

### Interactions
- Click "Create Agent" to open the screen.
- Type a prompt describing what the agent should do, then submit.
- A new agent entry appears in the sidebar list.

> **Note:** Agent sidebar entries have a random slug suffix in their `data-testid`, e.g. `agent-item-smoke-test-agent-9qux7n`. Always use a **prefix match**: `[data-testid^="agent-item-<agent-name>"]`.

## Home - Template Cards

### Components
- **Template cards** - preconfigured templates shown on the home page.

### Interactions
- Clicking a template opens the create screen with the template pre-selected at the name-your-agent step.
- If required environment variables are missing, user can cancel.
- Otherwise user can adjust the name and create the agent.

## Agent Detail - Container Lifecycle

### Components
- **Start button** - starts the agent container.
- **Status indicator** (`data-testid='agent-status'`) - shows `sleeping`, `starting`, `running`, or `idle`.

### Interactions
- Click Start to launch the container.
- Status transitions from `sleeping` -> `starting` -> `running` or `idle`.

## Sidebar - Agent Deletion

### Components
- **Delete Agent menu item** (`data-testid='delete-agent-item'`) - available from agent context menu.
- **Delete confirmation dialog** (`data-testid='confirm-delete-agent-dialog'`) - confirms delete.
- **Confirm Delete button** (`data-testid='confirm-delete-agent-button'`) - executes delete.

### Interactions
- Right-click an agent and choose Delete Agent.
- Confirm deletion in dialog.
- Agent is removed from the sidebar list.

