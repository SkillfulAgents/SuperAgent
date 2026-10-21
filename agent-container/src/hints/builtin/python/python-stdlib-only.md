---
name: python-stdlib-only
description: Plain python3 has only the standard library and is Python 3.11
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
`python3` here is Python 3.11 with only the standard library. If the script imports a third-party package (requests, PIL, ...), run it with `uv run --with <package> python ...` instead. In 3.11 an f-string can't contain a backslash inside `{}`: build that part in a variable first.
