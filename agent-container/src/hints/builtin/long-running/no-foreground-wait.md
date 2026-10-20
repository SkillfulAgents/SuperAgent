---
name: no-foreground-wait
description: Steers the agent away from sleep and poll loops that block the turn
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: sleep *
repeat: turn
---
Don't block the turn with `sleep` or poll loops. Background Bash commands and subagents notify you when they finish, so end your turn and continue when the notification arrives. For waits on outside systems (CI, deploys, another person), use `mcp__user-input__schedule_resume`. A pause of a few seconds, such as waiting for a local server to start, is fine.
