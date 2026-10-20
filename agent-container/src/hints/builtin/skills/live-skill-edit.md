---
name: live-skill-edit
description: Warns that editing a skill changes what scheduled runs and triggers do right away
triggers:
  - event: PreToolUse
    tool: Write
    input:
      file_path: /workspace/.claude/skills/*
  - event: PreToolUse
    tool: Edit
    input:
      file_path: /workspace/.claude/skills/*
repeat: turn
---
Schedules and triggers may run this skill, so an edit here takes effect the next time they run. If the user wants to review the change before it is live, write it somewhere else (for example `/workspace/drafts/`) and ask before applying it.
