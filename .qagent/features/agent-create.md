# Agent Create

This feature covers creating an agent, starting its container, and deleting it from the sidebar.

## Prerequisites

- The app is loaded and the sidebar is visible.

## Sidebar - Create Agent

### Components
- **New Agent button** (`data-testid='new-agent-button'`) - opens the New Agent menu (`data-testid='new-agent-menu'`) with three ways in. Each sidebar section's + (`data-testid='new-agent-in-folder-<id>'`, the agent is filed into that section) and the home page's New Agent buttons open the same menu; the app menu's New Agent goes straight to From Scratch.
  - **From Scratch** (`data-testid='new-agent-from-scratch'`) - the create page (`/new-agent`, `data-testid='new-agent-page'`): the same full-window screen as the last onboarding step, minus the template roster. Name → job → add-ons; nothing is created until Create Agent.
  - **Browse Templates** (`data-testid='new-agent-browse-templates'`) - the template page (`/new-agent/templates`, `data-testid='new-agent-templates-page'`): the roster on its own; a card opens the install dialog, and the roster ends with the Import an Agent tile (`data-testid='import-agent-card'`).
  - **Import** (`data-testid='new-agent-import'`) - opens the import dialog in place for a .agent/.zip package.
- **Name step** (`data-testid='agent-identity-step'`) - the create page's first step: a name field (`data-testid='agent-identity-name'`, required), the shape and colour grid for the orb (starts on a random pick), and Continue (`data-testid='agent-identity-continue'`, disabled until a name is typed; Enter also continues). Onboarding's last step opens on it too.
- **Identity avatar** (`data-testid='agent-identity-edit'`) - the chosen orb beside the describe step's question ("What job do you want to give me?", with the name above it); clicking it returns to the name step, keeping the typed prompt.
- **Prompt composer** (`data-testid='create-agent-prompt'`) - the agent's first instruction, with the model picker beside it.
- **Continue button** (`data-testid='create-agent-continue'`, bottom row opposite Back; cmd+enter in the composer too) - moves on to the add-ons step once a prompt is typed.
- **Add-ons step** (`data-testid='agent-addons-step'`) - the last step, "Want to give me any add-ons?": Skills (Self-Improvement, on by default; Proactivity), Knowledge & Context (Memories, on by default; Team Brain), Channels (Inbox, Slack). PROTOTYPE: the choices are collected but not applied yet.
- **Create Agent button** (`data-testid='create-agent-finish'`, bottom row) - creates the agent with the chosen name and orb (the prompt supplies its description) and its first session, then opens that session.
- **Back button** (`data-testid='new-agent-back'`) - one step back (add-ons → job → name), keeping what was entered; on the name step, returns to where New Agent was pressed, creating nothing.
- **Close X** (`data-testid='create-agent-close'`) - top right on every step; leaves without creating.

### Interactions
- Click New Agent in the sidebar, then From Scratch — the create page fills the window (no sidebar) on its name step.
- Type a name, optionally pick a shape and colour, then Continue.
- Type a prompt describing what the agent should do, then Continue (or cmd+enter).
- Toggle add-ons, then Create Agent.
- The agent appears in the sidebar with that name and orb, and its first session opens. From a section's +, it is filed into that section.
- New Agent → Browse Templates shows the roster full-window; picking a card installs it under the template's own name and orb.
- New Agent → Import opens the import dialog without leaving the page.
- Click Back — the page closes and no agent is created.

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

