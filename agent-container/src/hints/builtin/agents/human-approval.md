---
name: human-approval
description: Keeps the agent from passing its own yes off as the user's approval to another agent
triggers:
  - event: PreToolUse
    tool: mcp__agents__invoke_agent
repeat: turn
---
Only the user can approve. Don't tell another agent that the user approved something unless the user approved that exact action in this conversation. If the other agent needs a human yes, ask the user with the exact details first (`AskUserQuestion`), or give them its session with `mcp__user-input__deliver_session` so they answer there.
