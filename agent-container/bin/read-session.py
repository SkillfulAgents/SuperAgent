#!/usr/bin/env python3
"""Read one of this agent's own past sessions as a conversation.

By default this prints spoken turns only — what the user said and what the
agent said back — collapsing tool calls, tool results, and thinking into a
one-line marker. That is the readable form and the one to reach for first; pass
--full when the tool traffic is what you actually need.

Examples:
    python3 /opt/gamut/bin/read-session.py latest
    python3 /opt/gamut/bin/read-session.py a1b2c3d4          # id prefix is enough
    python3 /opt/gamut/bin/read-session.py latest --limit 20 # last 20 turns
    python3 /opt/gamut/bin/read-session.py latest --grep deploy
    python3 /opt/gamut/bin/read-session.py latest --full

Finding a session id: python3 /opt/gamut/bin/list-sessions.py
"""

import argparse
import datetime as dt
import json
import os
import re

DEFAULT_CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR", "/workspace/.claude")

NOISE_PREFIXES = (
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<user-prompt-submit-hook>",
    "Caveat: The messages below were generated",
    "[SYSTEM] ",  # container-injected notice, not something the user typed
)
SYSTEM_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)
COLLAPSED = "  ⋯ tool calls + thinking ⋯"


def sessions_dir(explicit):
    """Same resolution as list-sessions.py — see its docstring."""
    if explicit:
        return explicit
    projects = os.path.join(DEFAULT_CONFIG_DIR, "projects")
    preferred = os.path.join(projects, "-workspace")
    if os.path.isdir(preferred):
        return preferred
    try:
        candidates = [
            os.path.join(projects, name)
            for name in sorted(os.listdir(projects))
            if os.path.isdir(os.path.join(projects, name))
        ]
    except OSError:
        return preferred
    return candidates[0] if len(candidates) == 1 else preferred


TIMESTAMP_RE = re.compile(r'"timestamp":"(\d{4}-\d\d-\d\dT[\d:.]+Z?)"')
TAIL_BYTES = 256 * 1024


def last_activity(path):
    """Latest timestamp in a transcript's tail — see list-sessions.py.

    Not the file's mtime: a container restart re-appends history to every
    transcript and would make them all look equally recent.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            handle.seek(max(0, size - TAIL_BYTES))
            stamps = TIMESTAMP_RE.findall(handle.read().decode("utf-8", "replace"))
        if stamps:
            return max(stamps)
        return dt.datetime.fromtimestamp(
            os.path.getmtime(path), dt.timezone.utc
        ).isoformat()
    except OSError:
        return ""


def resolve_session(directory, wanted):
    """Map `latest`, `latest-2`, a full id, or an id prefix to a transcript path."""
    try:
        names = [n for n in os.listdir(directory) if n.endswith(".jsonl")]
    except OSError:
        raise SystemExit(f"No transcript directory at {directory}")
    if not names:
        raise SystemExit(f"No transcripts in {directory}")

    match = re.fullmatch(r"latest(?:-(\d+))?", wanted)
    if match:
        offset = int(match.group(1) or 0)
        by_recency = sorted(
            names, key=lambda n: last_activity(os.path.join(directory, n)), reverse=True
        )
        if offset >= len(by_recency):
            raise SystemExit(f"Only {len(by_recency)} session(s) exist; no {wanted}")
        return os.path.join(directory, by_recency[offset])

    exact = f"{wanted}.jsonl"
    if exact in names:
        return os.path.join(directory, exact)
    prefixed = [n for n in names if n.startswith(wanted)]
    if len(prefixed) == 1:
        return os.path.join(directory, prefixed[0])
    if not prefixed:
        raise SystemExit(f"No session matching {wanted!r} in {directory}")
    raise SystemExit(f"{wanted!r} matches {len(prefixed)} sessions; use a longer prefix")


def block_text(blocks, max_chars):
    """Render one message's content blocks into (spoken, rendered) text.

    `spoken` is text the user or agent actually said; `rendered` additionally
    carries tool traffic, and is only used under --full.
    """
    spoken, rendered = [], []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            text = block.get("text", "")
            spoken.append(text)
            rendered.append(text)
        elif kind == "thinking":
            rendered.append(f"[thinking] {truncate(block.get('thinking', ''), max_chars)}")
        elif kind == "tool_use":
            payload = json.dumps(block.get("input", {}), ensure_ascii=False)
            rendered.append(f"[tool_use: {block.get('name')}] {truncate(payload, max_chars)}")
        elif kind == "tool_result":
            rendered.append(f"[tool_result] {truncate(result_text(block), max_chars)}")
    return "\n".join(spoken).strip(), "\n".join(rendered).strip()


def result_text(block):
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def truncate(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def turns(path, max_chars, sidechains):
    """Stream a transcript into (timestamp, role, spoken, rendered) turns.

    `rendered` always carries the tool traffic; the caller picks which view to
    print, and uses an empty `spoken` as the signal to collapse a turn.
    """
    seen = set()
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            kind = entry.get("type")

            if entry.get("isSidechain") and not sidechains:
                continue  # subagent traffic

            # Resuming a session re-appends the whole prior history verbatim,
            # with the original uuids — without this the conversation prints
            # two or three times over.
            uuid = entry.get("uuid")
            if uuid is not None:
                if uuid in seen:
                    continue
                seen.add(uuid)

            if kind == "system":
                if entry.get("subtype") == "compact_boundary":
                    marker = "[context compacted]"
                    yield entry.get("timestamp", ""), "system", marker, marker
                elif entry.get("subtype") == "informational":
                    note = f"[note] {entry.get('content', '')}".strip()
                    yield entry.get("timestamp", ""), "system", note, note
                continue

            if kind == "attachment":
                attachment = entry.get("attachment") or {}
                if (
                    attachment.get("type") != "queued_command"
                    or attachment.get("commandMode") != "prompt"
                    or attachment.get("isMeta")
                ):
                    continue
                content = attachment.get("prompt")
                role, timestamp = "user", entry.get("timestamp", "")
            elif kind in ("user", "assistant"):
                content = entry.get("message", {}).get("content")
                role, timestamp = kind, entry.get("timestamp", "")
            else:
                continue

            if isinstance(content, str):
                text = SYSTEM_REMINDER_RE.sub("", content).strip()
                if not text or text.startswith(NOISE_PREFIXES):
                    continue
                yield timestamp, role, text, text
            elif isinstance(content, list):
                spoken, rendered = block_text(content, max_chars)
                spoken = SYSTEM_REMINDER_RE.sub("", spoken).strip()
                if not spoken and not rendered:
                    continue
                yield timestamp, role, spoken, rendered


def main():
    parser = argparse.ArgumentParser(
        description="Read one past session as a conversation.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("session", help="session id, id prefix, `latest`, or `latest-N`")
    parser.add_argument("--full", action="store_true",
                        help="include tool calls, tool results, and thinking")
    parser.add_argument("--limit", type=int, default=0,
                        help="show only the last N turns (default: all)")
    parser.add_argument("--grep", metavar="PATTERN",
                        help="show only turns matching this regex")
    parser.add_argument("--max-chars", type=int, default=400,
                        help="truncate each tool/thinking block to this many chars (--full)")
    parser.add_argument("--sidechains", action="store_true",
                        help="include subagent (sidechain) turns")
    parser.add_argument("--dir", metavar="DIR",
                        help="transcript directory (default: $CLAUDE_CONFIG_DIR/projects/-workspace)")
    args = parser.parse_args()

    path = resolve_session(sessions_dir(args.dir), args.session)
    pattern = re.compile(args.grep, re.IGNORECASE) if args.grep else None

    lines = []
    pending_internal = False
    for timestamp, role, spoken, rendered in turns(path, args.max_chars, args.sidechains):
        text = rendered if args.full else spoken
        # Without --full, a turn that was only tools/thinking collapses into one
        # marker so the conversation stays readable instead of vanishing.
        if not text:
            pending_internal = True
            continue
        if pattern and not pattern.search(text):
            continue
        # A filtered view is a set of hits, not a conversation — the collapse
        # markers would only be noise between them.
        if pending_internal and not pattern:
            lines.append(COLLAPSED)
        pending_internal = False
        stamp = timestamp.replace("T", " ")[:19]
        lines.append(f"\n[{stamp}] {role}:\n{text}")
    if pending_internal and not pattern:
        lines.append(COLLAPSED)

    session_id = os.path.basename(path)[: -len(".jsonl")]
    print(f"── {session_id} ──")
    if not lines:
        print("(no matching turns)")
        return
    if args.limit:
        lines = lines[-args.limit:]
    for line in lines:
        print(line)
    # The agent is holding the id right here, which is the moment the hint is
    # actionable — the user who asked "which session was that?" wants the card,
    # not the id pasted into chat.
    print(f"\n── end of {session_id} ── If the user was looking for this "
          "conversation, surface it with mcp__user-input__deliver_session "
          f'(session_id="{session_id}", omit agent_slug — it is your own).')


if __name__ == "__main__":
    main()
