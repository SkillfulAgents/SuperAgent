Built-in hints: one file per hint at `<topic>/<name>.md`, where `<name>` equals the frontmatter `name`.

```md
---
name: no-foreground-sleep
description: Shown in the hints list
triggers:
  - event: PreToolUse        # UserPromptSubmit | PreToolUse | PostToolUse
    match: Bash(sleep *)     # tool events: Tool or Tool(pattern); UserPromptSubmit: regex on the prompt
---
Short text the agent sees when a trigger matches.
```

Set `BUILTIN_HINTS=0` in the container env to turn all built-in hints off (read once at start).
