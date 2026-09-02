# Agent Settings

Per-agent settings live in one menu, reached from every agent entry point:
right-click an agent row in the sidebar, right-click the agent title or
breadcrumb, or click the three-dot button on the agent home header.

## Prerequisites

- An agent exists and its detail page is open.

## Agent Menu

### Components
- **Agent menu button** (`data-testid='agent-settings-button'`) - three-dot on the agent home header; opens the menu.
- **Agent menu** (`data-testid='agent-context-menu'`) - the same menu a sidebar right-click opens.
- **Edit Agent** (`data-testid='rename-agent-item'`) - owners only. From the agent home it puts the inline title into edit mode; elsewhere it opens a rename dialog (`data-testid='rename-agent-dialog'`).
- **Export Agent** (`data-testid='export-agent-item'`) - owners only. Opens the Share popover on its Export pane; from a menu away from the agent home it navigates there first.
- **Agent Directory** (`data-testid='open-agent-directory-item'`) - owners only. Opens the workspace folder panel (the same one the agent home's "Agent Directory" row opens); from a menu away from the agent home it navigates there first.
- **Move to Folder** (`data-testid='move-agent-to-folder-trigger'`) - submenu of left-nav folders.
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
