---
name: inspect-webhook-events
description: Points the agent to the right check when a trigger is not a custom webhook endpoint
triggers:
  - event: PreToolUse
    tool: mcp__user-input__inspect_webhook_events
repeat: turn
---
`inspect_webhook_events` only works for custom webhook endpoints made with `create_webhook_endpoint`. A trigger from `setup_trigger` (a connected-account event) has no endpoint to inspect: use `list_triggers` to see its status instead.
