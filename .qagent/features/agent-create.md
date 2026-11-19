# Agent Create

This feature covers creating an agent, starting its container, and deleting it from the sidebar.

## Create an agent

- Click **New Agent** in the sidebar, home page, app menu, or a section’s **+**.
- Enter a name, choose a gem, and continue. The agent is saved and the job composer opens. A section’s **+** also files it there.
- **Browse Templates** opens the template roster. **Import an Agent** opens the package dialog on that page. Back restores the name and gem. Expanding a category keeps the installation in the selected sidebar section.
- **Skip** on the job step opens the named agent’s empty home. Entering a job and continuing opens the add-ons step.
- Self-Improvement installs Dream from the public skillset and adds the scheduling instruction to the job sent by Start session. Skip leaves the skill installed and sends no job. Memories controls Claude auto memory for new sessions. Team Brain uses the workspace’s configured shared drive. Inbox and Slack open their setup forms. An unfinished Slack installation offers Finish setup.
- **Start session** sends the job to this agent. Refreshing during setup preserves the saved agent, its job draft, and applied add-ons. Retrying an accepted first job opens its original session.


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

