---
name: no-secret-values
description: Keeps secret values out of tool output when the agent inspects .env or the environment
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: cat *.env*
  - event: PreToolUse
    tool: Bash
    input:
      command: env *
  - event: PreToolUse
    tool: Bash
    input:
      command: printenv *
  - event: PreToolUse
    tool: Read
    input:
      file_path: "*/.env"
repeat: turn
---
Tool output is saved in the conversation, so don't print secret values. To see which secrets exist, show names only (for example `sed 's/=.*/=<set>/' /workspace/.env`), and use the values through environment variables (`uv run --env-file .env ...`, `$NAME`).
