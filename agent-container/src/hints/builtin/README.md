Built-in hints: one file per hint at `<topic>/<name>.md`, where `<name>` equals the frontmatter `name`.

```md
---
name: no-foreground-sleep
description: Shown in the hints list
triggers:
  - event: PreToolUse        # UserPromptSubmit | PreToolUse | PostToolUse
    match: Bash(sleep *)     # tool events: Tool or Tool(pattern); UserPromptSubmit: regex on the prompt
repeat: turn                 # optional; turn (default) = first match per user message, once = per session, always = every match
---
Short text the agent sees when a trigger matches.
```

A `Bash(pattern)` is tested against each part of a chained command (split on `&&`, `||`, `;`, `|` and newlines). The split does not understand quotes.

Set `BUILTIN_HINTS=0` in the container env to turn all built-in hints off (read once at start).

Adding a new event touches: `HINT_EVENTS` and `HintEventInput` (`hint-schema.ts`), `MATCHER_COMPILERS` (`hint-matchers.ts`), `toHintEventInput` and `createHintHookMatchers` (`hints-hook.ts`), and the `hooks` block in `claude-code.ts`.
