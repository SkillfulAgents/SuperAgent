Built-in hints: one file per hint at `<topic>/<name>.md`, where `<name>` equals the frontmatter `name`.

```md
---
name: uv-run-env-file
description: Shown in the hints list
triggers:
  - event: PreToolUse          # PreToolUse | PostToolUse
    tool: Bash                 # exact tool name, MCP tools included
    input:                     # optional; every field must match its glob
      command: uv run *
    unless:                    # optional; no field may match its glob
      command: "*--env-file*"
  - event: UserPromptSubmit
    prompt: \bdeploy\b         # case-insensitive regex on the prompt text
repeat: turn                   # optional; turn (default) = first match per user message, once = per session, always = every match
---
Short text the agent sees when a trigger matches.
```

Globs: `*` matches anything, spaces match any whitespace, and a trailing ` *` means "this word, then anything" (`ls *` matches `ls -la`, not `lsof`). A Bash `command` is checked part by part after splitting on `&&`, `||`, `;`, `|` and newlines, so `input` and `unless` apply to the same part. The split does not understand quotes. Other fields are checked as one value (booleans and numbers as text, e.g. `"true"`); a missing field never matches `input` and never matches `unless`.

Set `BUILTIN_HINTS=0` in the container env to turn all built-in hints off (read once at start).

Adding a new event touches: `HINT_EVENTS`, the trigger schemas and `HintEventInput` (`hint-schema.ts`), `compileTrigger` (`hint-matchers.ts`), `toHintEventInput` and `createHintHookMatchers` (`hints-hook.ts`), and the `hooks` block in `claude-code.ts`.
