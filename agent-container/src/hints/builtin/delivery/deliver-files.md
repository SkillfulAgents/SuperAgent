---
name: deliver-files
description: Reminds the agent to deliver files it wrote for the user
triggers:
  - event: PostToolUse
    tool: Write
    input:
      file_path: /workspace/*.csv
  - event: PostToolUse
    tool: Write
    input:
      file_path: /workspace/*.pdf
  - event: PostToolUse
    tool: Write
    input:
      file_path: /workspace/*.xlsx
  - event: PostToolUse
    tool: Write
    input:
      file_path: /workspace/*.docx
  - event: PostToolUse
    tool: Write
    input:
      file_path: /workspace/*.pptx
repeat: turn
---
If this file is for the user, deliver it with `mcp__user-input__deliver_file` so it appears as a download in the chat.
