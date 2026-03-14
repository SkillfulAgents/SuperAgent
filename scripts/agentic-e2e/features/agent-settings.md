# Agent Settings Dialog

The agent settings dialog (data-testid='agent-settings-dialog') is opened via the settings button in the main content header (data-testid='agent-settings-button'). It is organized into tabbed sections.

## General Tab

The default tab when the dialog opens.

**Components:**
- Agent name input field — pre-filled with the current agent name
- Save button

**User interactions:** Users can clear and edit the agent name, then save. The updated name is reflected in both the sidebar and the header.

## System Prompt Tab

**Components:**
- Text area for custom system instructions — pre-filled with any existing prompt
- Save button

**User interactions:** Users can write or replace system-level instructions for the agent, then save.

## Secrets Tab

**Components:**
- Key name input field
- Value input field
- "Add Secret" button
- Secrets list — each row displays a key name and a delete (trash) icon

**User interactions:** Users can add a secret by entering a key/value pair and clicking "Add Secret"; the new entry appears in the list. Users can remove a secret by clicking its delete icon; the row is removed from the list.

## Accounts Tab

**Components:**
- Connected accounts list — each row shows an account display name and a remove (trash) icon
- "Add accounts" button, which opens a picker dialog with checkboxes for available accounts and an "Add N account(s)" confirmation button

**User interactions:** Users can add one or more accounts from the picker and confirm. Added accounts appear in the connected accounts list. Users can remove an account by clicking its delete icon. The picker may be empty if no accounts are available.

## MCPs Tab

**Components:**
- MCP servers list — each row shows a server name and a remove (trash) icon
- "Add MCP servers" button, which opens a picker dialog with checkboxes for available servers and an "Add N server(s)" confirmation button

**User interactions:** Users can add one or more MCP servers from the picker and confirm. Added servers appear in the list. Users can remove a server by clicking its delete icon. The picker may be empty if no servers are available.
