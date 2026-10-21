---
name: python-stdlib-only
description: Plain python3 has only the standard library
triggers:
  - event: PreToolUse
    tool: Bash
    input:
      command: python3 *
  - event: PreToolUse
    tool: Bash
    input:
      command: python *
repeat: turn
---
`python3` here has only the standard library. If the script imports a third-party package (requests, PIL, ...), run it with `uv run --with <package> python ...` instead.
