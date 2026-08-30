# Your Own Session History

Read this guide when the user refers to something from an earlier conversation
— "we talked about this last week", "what did we decide about the pricing
page", "you already wrote that script" — or when you want to check what you did
before repeating work.

Every conversation you have ever had with this user is on disk in this
container, and you can read all of it. Nothing about recalling your own history
needs the user's help, a tool call, or another agent.

## Do Not Use the Cross-Agent Tools For This

`mcp__agents__get_agent_sessions` and `mcp__agents__get_agent_session_transcript`
read **other** agents' sessions. They cannot see your own, they cost a user
approval, and reaching for them here is the common wrong turn. Your own history
is files. Read the files.

## Where Sessions Live

```
/workspace/.claude/projects/-workspace/<session-id>.jsonl
```

One JSONL file per session, named after the session id. This is
`$CLAUDE_CONFIG_DIR/projects/-workspace`, where `-workspace` is the slug of the
`/workspace` working directory; if a session ran with a different working
directory it lands under a differently-named sibling, so list `projects/` when
the expected directory is missing. Transcripts are never age-pruned, so the
directory goes back to the agent's first conversation.

Related paths in the same tree:

| Path | What it holds |
|---|---|
| `<session-id>/subagents/agent-<id>.jsonl` | one subagent (Task) transcript |
| `<session-id>/subagents/workflows/<run-id>/` | workflow journal + per-agent transcripts |
| `/workspace/session-metadata.json` | the names, stars, and provenance the app keeps per session |
| `/workspace/.superagent-sessions.json` | the container's own session index (model, effort, timestamps) |
| `<CLAUDE_CONFIG_DIR>/projects/-workspace/memory/` | your auto-memory (see the memory section of the system prompt) |

Memory and transcripts answer different questions. Memory is what you chose to
carry forward; the transcript is what was actually said. When memory is thin or
the user is asking about specifics — a decision, a number, a file you touched —
go to the transcript.

## The Two Helpers

Both are plain stdlib Python, installed read-only in the image, and safe to run
against a session that is still being written.

### Find the session

```bash
python3 /opt/gamut/bin/list-sessions.py
python3 /opt/gamut/bin/list-sessions.py --since 7d
python3 /opt/gamut/bin/list-sessions.py --grep 'pricing page'
python3 /opt/gamut/bin/list-sessions.py --sort started --oldest-first
python3 /opt/gamut/bin/list-sessions.py --json --limit 100
```

One row per session, newest activity first: timestamp (UTC, like the timestamps
inside a transcript), session id, size, and a headline — the name the app stored, or the first user message when it has none.
`--grep` scans whole transcripts, keeps only the sessions that match, and ranks
them by hit count with the count shown — the fastest way from "we discussed X"
to a session id. Trust that ranking rather than counting matches yourself: a
common word turns up in nearly every session, and the hit count is what
separates the conversation about X from the ones that merely mention it.
`--sort started --oldest-first` walks the history forwards instead, for "what
have we worked on so far".

Those timestamps are read out of the transcripts, not taken from file mtimes —
restarting the container re-appends prior history to every transcript and so
stamps them all with the restart time. Never order sessions with `ls -t` for
that reason.

### Read the conversation

```bash
python3 /opt/gamut/bin/read-session.py <session-id>       # id prefix is enough
python3 /opt/gamut/bin/read-session.py latest
python3 /opt/gamut/bin/read-session.py latest-1 --limit 40
python3 /opt/gamut/bin/read-session.py <id> --grep deploy
python3 /opt/gamut/bin/read-session.py <id> --full
```

The default view is spoken turns only — what the user said and what you said
back — with runs of tool calls, tool results, and thinking collapsed into a
`⋯ tool calls + thinking ⋯` marker. That is the view to reach for first: it is
usually a small fraction of the file and it is what the user means by "the
conversation". Add `--full` only when the tool traffic itself is the question
(what command did I run, what did that API return), and pair it with `--limit`
or `--grep`, because a full transcript can be tens of megabytes.

`--sidechains` adds subagent turns, which are hidden by default.

Both scripts take `--dir` if you ever need to point them at another transcript
directory.

## Surfacing What You Found

When the user's goal is the conversation itself — "find the session where we
discussed the refund policy", "which chat was that in?" — an id pasted into
chat is not much use to them. Call `mcp__user-input__deliver_session` with the
`session_id` and **omit `agent_slug`**: leaving it out is what marks the session
as one of your own, and the card then resolves the session's real name and
gives the user a button that opens it. Pass `description` to say why this is the
one.

Deliver the card *and* answer the question — the card is how they get back to
the conversation, not a substitute for telling them what it said. Only pass
`agent_slug` when the session belongs to a different agent.

## Searching Across Every Session

`grep` is available; `rg` is not. Transcripts are one JSON object per line, so
line-oriented tools work directly:

```bash
# which sessions mention a thing
grep -l 'stripe webhook' /workspace/.claude/projects/-workspace/*.jsonl

# with a little context
grep -i -h -o '.\{0,120\}refund policy.\{0,120\}' \
  /workspace/.claude/projects/-workspace/*.jsonl

# every message you sent that mentions a file
jq -r 'select(.type=="user" and (.message.content|type=="string"))
       | .message.content' /workspace/.claude/projects/-workspace/*.jsonl \
  | grep -i 'report.py'
```

A useful loop is: `list-sessions.py --grep <term>` to narrow to candidate
sessions, then `read-session.py <id> --grep <term>` to see those hits in
context, then `read-session.py <id> --limit 60` to read the surrounding
conversation.

## The JSONL Format

Every line is one JSON object with a `type`. Unknown types appear as the CLI
evolves — skip what you do not recognize rather than failing.

- `user` — `message.content` is **either a plain string** (what the user typed)
  **or an array of blocks**, in which case it is almost always a `tool_result`
  being fed back to you.
- `assistant` — `message.content` is an array of `text`, `thinking`, and
  `tool_use` blocks. One reply can span several lines that share a
  `message.id`.
- `attachment` — CLI bookkeeping, with one exception that matters: an
  `attachment.type` of `queued_command` with `commandMode: "prompt"` is a
  **real user message**, typed while you were mid-turn. Grepping only for
  `"type":"user"` misses those.
- `system` — `subtype` `compact_boundary` (the context was compacted here),
  `memory_recall`, or `informational` (a host-written notice).
- `file-history-snapshot`, `queue-operation` — internal, ignore.

Envelope fields on message lines: `uuid`, `parentUuid`, `timestamp` (ISO 8601),
`sessionId`, `cwd`, `gitBranch`, `version`, and `isSidechain`. A `user` line
carrying a tool result also has a sibling `toolUseResult` object with the raw
result.

Four things will bite a hand-rolled parser — the helpers already handle all of
them:

1. **Resuming re-appends the whole prior history verbatim, with the original
   uuids.** Deduplicate by `uuid` or you will print the conversation two or
   three times.
2. **`isSidechain: true` lines are subagent traffic**, not your conversation
   with the user.
3. **The CLI records its own bookkeeping as user messages** — content starting
   with `<command-name>`, `<local-command-stdout>`, `Caveat:`, or `[SYSTEM] `.
   None of it was typed by the user.
4. **`<system-reminder>` blocks are injected context**, not user words. Strip
   them before quoting anything back.

Transcripts are also rewritten in place when a message is deleted, so never
cache byte offsets.

## Quoting It Back

A transcript is a record of what was said, not a record of what is still true.
Before acting on something you read there, check the current state — the file,
the branch, the config — exactly as you would with a memory. Say which session
and roughly when, so the user can tell a fresh fact from a recovered one.
