# Agent Create

This feature covers the UI for creating agents, starting agent containers, and deleting agents.

## Sidebar — Create Agent Button

The sidebar contains a "Create Agent" button (data-testid='create-agent-button') that opens the agent creation dialog.

### Create Agent Dialog

A modal dialog (data-testid='create-agent-dialog') with:

- **Agent name input** (data-testid='agent-name-input') — text field for entering the new agent's name.
- **Submit button** (data-testid='create-agent-submit') — creates the agent and closes the dialog.

On successful creation, the new agent appears in the sidebar agent list.

## Home Page — Template Cards

The home page displays a collection of template cards. Each card represents a preconfigured agent template.

### Template-Based Creation

Clicking a template card opens the create agent dialog pre-filled with template settings. If the template requires environment variables that are not configured, the user can cancel. Otherwise, the user can adjust the agent name and confirm creation.

## Agent Detail — Container Lifecycle

Clicking an agent in the sidebar navigates to the agent detail view. The agent header contains:

- **Start button** — launches the agent's container.
- **Status indicator** (data-testid='agent-status') — shows the current container state. Possible states: `sleeping`, `starting`, `running`, `idle`. Container startup typically takes 30–120 seconds.

## Sidebar — Agent Context Menu

Right-clicking an agent in the sidebar opens a context menu with:

- **Delete Agent** (data-testid='delete-agent-item') — triggers a confirmation dialog.

### Delete Confirmation Dialog

A confirmation dialog (data-testid='confirm-delete-agent-dialog') with:

- **Delete button** (data-testid='confirm-delete-agent-button') — permanently removes the agent.

On successful deletion, the agent is removed from the sidebar list.
