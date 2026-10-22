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
  - event: UserPromptSubmit
    prompt: \bdeploy\b         # case-insensitive regex on the prompt text
repeat: turn                   # optional; turn (default) = first match per user message, once = per session, always = every match
---
Short text the agent sees when a trigger matches.
```

Globs: `*` matches anything, spaces match any whitespace, and a trailing ` *` means "this word, then anything" (`ls *` matches `ls -la`, not `lsof`). A Bash `command` is checked part by part after splitting on `&&`, `||`, `;`, `|` and newlines, and the glob only has to match one part. The split does not understand quotes. Other fields are checked as one value (booleans and numbers as text, e.g. `"true"`); a missing field never matches.

Set `BUILTIN_HINTS=0` in the container env to turn all built-in hints off (read once at start).

Adding a new event touches: `HINT_EVENTS` and the trigger schemas (`hint-schema.ts`), `HintEventInput` and `compileTrigger` (`hint-matchers.ts`), `toHintEventInput` and `createHintHookMatchers` (`hint-hook.ts`), and the `hooks` block in `claude-code.ts`.

## Writing a hint

A hint arrives mid-task with no context beyond the call that matched it, so it has to hold up everywhere its trigger matches, not just in the case that prompted it.

1. **Right for everything the trigger matches.** List what the trigger actually catches before writing the text. `sleep *` catches a stuck poll loop and also `sleep 2` after starting a server; the text must be correct, or at least harmless, for both.
2. **No promises the runtime doesn't keep.** "Background commands notify you when they finish" is false for a command that hangs, and an automated session that goes idle may never be woken. State the real behavior: "notifies you only when it exits".
3. **A check, then a conditional action.** Don't end on a bare "end your turn", "stop" or "kill". Tell the agent what to look at and what to do for each answer ("look once at its output and which step it is on; if it is stuck, find the cause"). The more destructive the action, the stricter the condition.
4. **General, not shaped to one case.** Keep examples that match the specific bug you saw out of the text; they make a test pass without showing the hint helps elsewhere.
5. **Mind the timing.** A `PreToolUse` hint does not stop the call it is attached to; the `sleep` still runs. It can only change the next step. If the call itself must not run, use a blocking hook instead.
6. **Narrow trigger.** If the advice only applies to long waits, match long waits. A hint that fires where it doesn't apply teaches the agent to ignore it.
7. **Detail matches the trigger.** A narrow trigger can carry a specific fact (`query` contains ` OR ` → "Sentry has no OR"); a broad one gets general advice (every `execute_sql` → "don't guess columns"). A specific fact on a broad trigger is wrong for most of the calls it fires on, so it is noise there; keep it only if it is true for almost every one of them.

## Testing a hint

A hint can only change a run in which it fires, so test where it fires rather than everything.

1. **Find where it fires.** `npx ts-node --transpile-only src/hints/hint-fires.ts <hint.md | hints dir> <transcripts dir>...` replays the tool calls and prompts in recorded session transcripts (`*.jsonl`, searched recursively) through the real loader and matchers, and prints per task how many runs it would fire in, with example calls. `<task>__<id>` folders count as one run each. Read the examples against rules 1 and 6.
2. **Run only those cases.** Compare the hint on vs off (or old vs new text) on the tasks where it fires, with enough repeats per model to see past run-to-run noise. Cases where it never fires can't be affected; differences there are noise.
3. **Change one thing at a time.** Text and trigger are separate changes; test them separately.
