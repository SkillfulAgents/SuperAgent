---
name: deliver-files
description: Reminds the agent to deliver files it made for the user
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
  - event: PostToolUse
    tool: Bash
    input:
      command: "*openpyxl*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*xlsxwriter*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*reportlab*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*weasyprint*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*fpdf*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*from pptx*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*import pptx*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*from docx*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*import docx*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*to_excel(*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*to_csv(*"
  - event: PostToolUse
    tool: Bash
    input:
      command: "*csv.writer(*"
repeat: turn
---
If you made a file for the user, deliver it with `mcp__user-input__deliver_file` so it appears as a download in the chat.
