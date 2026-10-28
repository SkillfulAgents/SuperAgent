---
name: background-redirected-output
description: Points the agent to the redirect target when a background command sends its output to a file
triggers:
  - event: PostToolUse
    tool: Bash
    input:
      run_in_background: "true"
      command: "*>*"
repeat: turn
---
If this background command redirects its output with `>`, that output goes to the redirect target, not to the task output file, so the task output file can stay empty while the command runs. To check progress, read the redirect target.
