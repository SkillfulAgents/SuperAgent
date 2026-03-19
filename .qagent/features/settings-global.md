# Global Settings

This feature covers opening global settings, tab navigation, and provider status visibility in key tabs.

## Prerequisites

- Sidebar footer is visible.

## Open Global Settings

### Components
- **Settings button** (`data-testid='settings-button'`) - gear icon in sidebar footer.
- **Global settings dialog** (`data-testid='global-settings-dialog'`) - tabbed modal.

### Interactions
- Click settings button and verify dialog opens.

## Tab Navigation

### Components
- **Tab list** - category navigation on left side.
- **Content area** - updates based on selected tab.

### Interactions
- Switch across tabs and verify content changes accordingly.

## LLM Tab

### Components
- **API key status** - indicates whether provider key is configured.

### Interactions
- Open LLM tab and verify status is displayed.

## Account Provider Tab

### Components
- **Provider key status** - indicates whether account-provider key is configured.

### Interactions
- Open Account Provider tab and verify status is displayed.

