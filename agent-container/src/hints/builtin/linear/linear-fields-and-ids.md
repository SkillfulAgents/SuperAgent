---
name: linear-fields-and-ids
description: Use Linear schema names and looked-up ids instead of guessing
triggers:
  - event: PreToolUse
    tool: mcp__linear__list_issues
  - event: PreToolUse
    tool: mcp__linear__get_issue
repeat: turn
---
Use only the names in the tool's schema, and look up ids (team keys, users, projects) with the list tools instead of guessing them.
