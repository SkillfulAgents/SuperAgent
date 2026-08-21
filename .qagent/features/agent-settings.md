# Agent Settings

This feature covers all tabs in the agent settings dialog: General, System Prompt, Accounts, and MCPs.

## Prerequisites

- An agent exists and its detail page is open.

## Settings Dialog

### Components
- **Agent settings button** (`data-testid='agent-settings-button'`) - opens the settings dialog.
- **Agent settings dialog** (`data-testid='agent-settings-dialog'`) - tabbed modal.

### Interactions
- Open the settings dialog from the agent header.

## General Tab

### Components
- **Agent name input** - editable current name.
- **Save button** - persists name changes.

### Interactions
- Rename the agent and save.
- Verify updated name in header and sidebar.

## System Prompt Tab

### Components
- **System prompt textarea** - editable instructions.
- **Save button** - persists prompt changes.

### Interactions
- Update prompt text and save.
- Re-open tab and verify persisted value.

## Accounts Tab

### Components
- **Connected accounts list** - currently linked accounts.
- **Add accounts button** - opens account picker.
- **Account picker** - checkbox list and confirm button.

### Interactions
- Add one or more accounts from picker.
- Remove linked account from list.

## MCPs Tab

### Components
- **Assigned MCP list** - MCP servers linked to current agent.
- **Add MCP servers button** - opens MCP picker.
- **MCP picker** - checkbox list and confirm button.

### Interactions
- Assign MCP servers to agent.
- Remove assigned MCP server.
