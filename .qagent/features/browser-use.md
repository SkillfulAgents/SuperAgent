# Browser Use

This feature covers browser capability settings, in-chat browser tool activity, and the live browser preview.

## Prerequisites

- Global settings are accessible.
- Agent can execute browser tools.

## Global Settings - Browser Use Tab

### Components
- **Browser Agent Model selector** - chooses model for browser actions.
- **Browser Host selector** - chooses where browser runs.

### Interactions
- Open global settings and switch to Browser Use tab.
- Verify model and host options are visible and selectable.

## Chat View - Browser Tool Calls

### Components
- **Tool call cards** - show browser tool name and result.
- Tool types include `browser_open`, `browser_screenshot`, `browser_snapshot`, `browser_click`, `browser_fill`, and `browser_close`.

### Interactions
- Trigger browser actions via chat.
- Verify tool call cards appear with relevant details.

## Main Content - Browser Preview

### Components
- **Live browser preview panel** - iframe/image stream while session is active.

### Interactions
- Verify preview appears when browser session starts.
- Verify preview updates as agent navigates and interacts.
- Verify preview disappears when browser session ends.

