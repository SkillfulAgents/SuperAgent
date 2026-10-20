---
name: update-skill-md
description: Reminds the agent to document skill changes in SKILL.md
triggers:
  - event: PostToolUse
    tool: Write
    input:
      file_path: /workspace/.claude/skills/*
  - event: PostToolUse
    tool: Edit
    input:
      file_path: /workspace/.claude/skills/*
repeat: turn
---
You changed a file in a skill. If you added scripts, capabilities, or parameters, update that skill's SKILL.md to document them. The SKILL.md description decides when the skill is invoked, so capabilities it doesn't mention won't be discoverable.
