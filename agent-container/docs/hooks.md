# Hooks

Read this guide before creating, changing, or removing a hook, or when the user
asks which hooks this agent has.

Hooks are commands the runtime runs automatically at lifecycle events: before
or after a tool call, when a user message arrives, when a turn ends. They are
standard Claude Code hooks; the full reference is
https://code.claude.com/docs/en/hooks.

## Where Hooks Live

Hooks live in the `hooks` key of `/workspace/.claude/settings.json`. That is the
only file that counts:

- `/workspace/.claude/settings.local.json` is not loaded; hooks there never run.
- `~/.claude` is not read.

The file holds other settings too. Change only the `hooks` key and keep every
other key. Check the result with `jq . /workspace/.claude/settings.json`: if the
file is not valid JSON, the user's Hooks list shows nothing and the user cannot
remove hooks from the home page.

Put hook scripts in `/workspace/.claude/hooks/`, make them executable, and
reference them by absolute path.

## Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "/workspace/.claude/hooks/check-bash.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

- Each event name maps to a list of matcher groups; each group has a list of
  hooks.
- `matcher` applies to tool events: an exact tool name, a regex such as
  `Edit|Write`, or `mcp__<server>__.*` for MCP tools. Omit it to match every
  tool, and for events that have no tool.
- `timeout` is in seconds; the default is 60.
- `type: "command"` runs a shell command. `type: "prompt"` has a model evaluate
  a prompt. Prefer command hooks: they are deterministic and cost nothing.

| Event | Fires | Typical use |
| --- | --- | --- |
| `PreToolUse` | before a tool call | block or check a call |
| `PostToolUse` | after a tool call succeeds | run a formatter, log, add a note |
| `UserPromptSubmit` | when a message arrives, before you see it | add context; can block the message |
| `Stop` | when you finish a turn | a final check; can make you keep working |
| `SessionStart` | when a session starts or resumes | load context |

## Input and Output

A command hook receives JSON on stdin: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, and the event's own fields: `tool_name` and `tool_input` for
tool events, `tool_response` for `PostToolUse`, `prompt` for
`UserPromptSubmit`, `stop_hook_active` for `Stop`. Parse it with `jq`.

The exit code decides what happens:

- `0`: continue. For `UserPromptSubmit` and `SessionStart`, stdout is added to
  your context.
- `2`: block. A `PreToolUse` call is refused and you see stderr as the reason. A
  `UserPromptSubmit` message is discarded before you see it. A `Stop` hook makes
  you keep working, with stderr as the reason.
- Any other code: a non-blocking error; work continues.

For finer control (deny with a reason, add context to a tool call), exit `0`
and print JSON on stdout; see the reference.

The command runs inside this container as the agent's user, in `/workspace`,
with `$CLAUDE_PROJECT_DIR` set to the workspace root.

## Scope and Timing

Hooks apply to every session of this agent: scheduled tasks, webhook triggers,
chat integrations, and subagents included, not only the conversation that
created them.

Count on a new or changed hook only from the next new session. It can also take
effect in the session that wrote it, so a broken `PreToolUse` hook can block
your own next tool calls.

Test a script before installing it by piping it a sample payload:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | /workspace/.claude/hooks/check-bash.sh; echo "exit $?"
```

## Safety

- Add a hook only when the user asks for one or agrees to your proposal. Tell
  them what it does and when it runs.
- A `UserPromptSubmit` hook runs before every message, the user's included. If
  it blocks, the agent stops responding until the hook is removed. Make one
  block only when the user explicitly wants that.
- A blocking `Stop` hook loops forever unless it exits `0` when
  `stop_hook_active` is `true`.
- Keep matchers narrow and hooks fast. A hook runs on every matching event in
  every session, and a slow one delays each of them.

## Managing Hooks

- To list hooks, read the `hooks` key of `/workspace/.claude/settings.json`.
- To remove one, delete its entry, then drop any matcher group or event left
  empty. Keep every other key.
- The user sees every hook in the Hooks section of this agent's home page, and
  an owner can remove any of them there. Tell the user when you add or remove
  one.
