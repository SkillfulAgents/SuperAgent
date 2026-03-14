# Global Settings

The global settings dialog provides application-wide configuration options organized into tabbed sections. It is accessed from the sidebar footer.

## Opening Global Settings

### Components

- **Settings button** (data-testid=`settings-button`): a gear icon located in the sidebar footer.
- **Global settings dialog** (data-testid=`global-settings-dialog`): a modal dialog containing the settings interface.

### Interactions

- Clicking the settings button opens the global settings dialog.

## Tab Navigation

The dialog uses a left-side tab navigation to organize settings into categories.

### Components

- **Tab list**: a vertical list of tabs on the left side of the dialog. Tabs include General, Notifications, LLM, Browser Use, MCPs, Account Provider, among others.
- **Content area**: the right side of the dialog, which updates to reflect the selected tab's settings.

### Interactions

- Clicking a tab switches the content area to display that tab's configuration options.

## LLM Tab

Manages API key configuration for language model providers.

### Components

- **API key status**: indicates whether an API key is currently configured.

### Interactions

- The tab displays the current configuration status. API keys are typically pre-configured externally, so this tab serves as a verification point.

## Account Provider Tab

Manages third-party account provider credentials (e.g., Composio).

### Components

- **Key status**: indicates whether the account provider key is currently configured.

### Interactions

- The tab displays the current configuration status. Credentials are typically pre-configured externally, so this tab serves as a verification point.
