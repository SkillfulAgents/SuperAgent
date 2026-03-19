# Agent Settings

This feature covers all tabs in the agent settings dialog: General, System Prompt, Secrets, Accounts, and MCPs.

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

## Secrets Tab

### Components
- **Secret key input** - secret name.
- **Secret value input** - secret value.
- **Add Secret button** - creates a secret.
- **Secrets list** - rows with delete icons.

### Interactions
- Add a secret and verify list entry.
- Delete a secret and verify entry removal.

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

