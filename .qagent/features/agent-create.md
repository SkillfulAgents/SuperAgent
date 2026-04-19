# Agent Create

This feature covers creating an agent, starting its container, and deleting it from the sidebar.

## Prerequisites

- The app is loaded and the sidebar is visible.

## Sidebar - Create Agent

### Components
- **Create Agent button** (`data-testid='create-agent-button'`) - immediately creates an Untitled agent and lands on its AgentHome.
- **Prompt composer** (`data-testid='home-message-input'`) - textarea for the agent's first instruction; the agent's name auto-updates from the prompt after the first send.
- **Create Agent / Send button** (`data-testid='home-send-button'`) - submits the prompt. Labeled "Create Agent" on a fresh Untitled agent, the normal send icon thereafter.
- **Voice / Import cards** - below the composer in the empty-session state. Voice fills the composer with an AI-drafted prompt; Import creates a new agent from a .zip template (the Untitled agent is removed on success).

### Interactions
- Click "Create Agent" in the sidebar — a new Untitled agent appears and the AgentHome for it is shown.
- Type a prompt describing what the agent should do, then click Create Agent (or cmd+enter).
- A first session is started; the sidebar row renames from Untitled based on the prompt.

> **Note:** Agent sidebar entries have a random slug suffix in their `data-testid`, e.g. `agent-item-smoke-test-agent-9qux7n`. Always use a **prefix match**: `[data-testid^="agent-item-<agent-name>"]`.

## Home - Template Cards

### Components
- **Template cards** - preconfigured templates shown on the home page.

### Interactions
- Clicking a template opens a lightweight install dialog where the user names the agent and installs it (handles required env vars).
- On success, the new agent is selected and shown in the sidebar.

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

