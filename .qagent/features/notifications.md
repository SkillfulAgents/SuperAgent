# Notifications

This feature covers the notification bell, unread indicators, notifications popover, and read-state transitions.

## Prerequisites

- Agent activity exists that can generate notifications.

## Sidebar Footer - Notification Bell

### Components
- **Bell icon** - opens notifications popover.
- **Unread badge** - shows unread count when `unreadCount > 0`.

### Interactions
- Click bell icon to open notifications.
- Verify unread badge visibility matches unread state.

## Notifications Popover

### Components
- **Notification list** - list of notifications or empty state.
- **Notification item** - summary row with unread indicator.
- **Mark all read button** - visible only when unread notifications exist.

### Interactions
- Click a notification item and verify navigation + mark-as-read.
- Click "Mark all read" and verify unread badge/button disappear.

