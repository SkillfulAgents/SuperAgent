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
Don't block the turn with long `sleep` or poll loops. A background command notifies you only when it exits, so one that hangs never does. Before you end your turn to wait, look once: read its latest output and check with `ps` that it is still doing work. If it has printed nothing for over a minute and isn't busy, it is probably stuck (for example, waiting on a prompt or a remote that never answers): find the cause before waiting again. For outside systems that take minutes or more (CI, deploys, another person), use `mcp__user-input__schedule_resume` to check back. A pause of a few seconds, such as waiting for a local server to start, is fine.
