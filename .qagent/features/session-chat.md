# Session Chat

This feature covers new session creation, ongoing chat behavior, and sidebar-based session management.

## Prerequisites

- Agent status is `running` or `idle`.

## Agent Landing Page

### Components
- **Message input** (`data-testid='home-message-input'`) - compose first message.
- **Send button** (`data-testid='home-send-button'`) - submits first message.

### Interactions
- Submit first message from landing page.
- Verify navigation into chat view and first message persistence.

## Chat View

### Components
- **Message list** (`data-testid='message-list'`) - chronological conversation history.
- **Message input** (`data-testid='message-input'`) - follow-up message input.
- **Send button** (`data-testid='send-button'`) - submits follow-up message.
- **Activity indicator** (`data-testid='activity-indicator'`) - shown while agent responds. Displays "Working..." during normal processing, "Compacting conversation..." (violet pulse) when SDK signals compaction in progress, or "Waiting for input..." (orange pulse) when awaiting user input.
- **Stop button** (`data-testid='stop-button'`) - interrupts active response.
- **Tool call cards** - inline tool usage indicators.
- **Attachment button** - opens native file picker.

### Interactions
- Send follow-up message and verify activity indicator appears then disappears.
- Verify assistant response is appended to list.
- Interrupt response with stop button and verify input is re-enabled.
- During context compaction, verify activity indicator shows "Compacting conversation..." instead of generic "Working...".

## Sidebar - Session Management

### Components
- **Agent name link** - returns to landing page for new session.
- **Session list** - all sessions for current agent.
- **Session context menu** - includes delete action.
- **Delete confirmation dialog** - confirms session deletion.

### Interactions
- Create multiple sessions and switch among them.
- Delete a session from context menu and verify removal.

