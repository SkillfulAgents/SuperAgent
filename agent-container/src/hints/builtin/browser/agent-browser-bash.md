---
name: agent-browser-bash
description: Steers Bash calls to agent-browser back to the dedicated browser tools
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: agent-browser *
  - event: PreToolUse
    tool: Bash
    input:
      command: which agent-browser *
repeat: always
---
STRONG WARNING: This Bash command is probably bypassing Gamut's browser integration. For website work, use the dedicated mcp__browser__browser_* tools; if they are deferred, load their exact full names with ToolSearch. The Bash command is still allowed, but continue with agent-browser only when the dedicated browser tools genuinely cannot perform the operation.
