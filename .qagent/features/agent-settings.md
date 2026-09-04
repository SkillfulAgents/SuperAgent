# Agent Settings

Per-agent settings live in one menu, reached from every agent entry point:
right-click an agent row in the sidebar, a home card, or a node on the home
connections graph; right-click the agent title or breadcrumb; or click the
three-dot button on the agent home header.

## Prerequisites

- An agent exists and its detail page is open.

## Agent Menu

### Components
- **Agent menu button** (`data-testid='agent-settings-button'`) - three-dot on the agent home header; opens the menu.
- **Agent menu** (`data-testid='agent-context-menu'`) - the same menu a sidebar right-click opens.
- **Rename Agent** (`data-testid='rename-agent-item'`) - owners only. From the agent home it puts the inline title into edit mode; elsewhere it opens a rename dialog (`data-testid='rename-agent-dialog'`).
- **Export Agent** (`data-testid='export-agent-item'`) - owners only. Opens the Share popover on its Export pane; from a menu away from the agent home it navigates there first.
- **Agent Directory** (`data-testid='open-agent-directory-item'`) - owners only. Opens the workspace folder panel (the same one the agent home's "Agent Directory" row opens); from a menu away from the agent home it navigates there first.
- **Move to Folder** (`data-testid='move-agent-to-folder-trigger'`) - submenu (`data-testid='move-agent-to-folder-menu'`) listing only the left-nav folders the agent can move to (`move-agent-to-folder-<id>`, or `move-agent-to-no-folder-item` for "Your Agents"); the folder it is in is left out, so nothing is marked as selected. **New Folder** (`move-agent-to-new-folder-item`) is always offered.
- **Delete Agent** (`data-testid='delete-agent-item'`) - owners only; opens the confirm dialog.
- **Leave Agent** (`data-testid='leave-agent-item'`) - non-owners in auth mode.

### Interactions
- Open the menu from the sidebar and from the header button; confirm the items match.
- Rename the agent from each entry point; verify the new name in header and sidebar.

## Retention rows (agent home card)

Under **Agent Default Model** in the agent home's right-hand card:
- **Session Auto-Delete** (`data-testid='home-session-auto-delete-trigger'`) - dropdown; options plus "Reset to Global Default".
- **API Log Auto-Delete** (`data-testid='home-api-log-auto-delete-trigger'`) - same dropdown shape.

### Interactions
- Pick an option; the trigger shows it. Reset returns the trigger to the app default value.

## Agent Directory panel (folder header actions)

Opened by **Agent Directory** in the menu, or the agent home's "Agent Directory" row. Owners only:
- **Copy folder path** (`data-testid='folder-copy-path'`) - copies the folder's host path (the API host's path when the workspace is remote).
- **Reveal in Finder / File Explorer** (`data-testid='folder-reveal'`) - Electron only, and only when the API runs on this computer; opens the folder in the OS file manager.

## Template Status (Share popover, Publish pane)

For an agent installed from a library, the Publish pane shows **Template Status** (`data-testid='agent-template-status'`) instead of the publish flow: status badge, refresh, and the actions the status allows - **Update** (`agent-template-update-button`), **Force Sync** (`agent-template-force-sync-button`, confirms first), **Submit for review / Create PR** (`agent-template-submit-button`).
