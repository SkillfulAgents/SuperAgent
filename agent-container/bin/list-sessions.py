#!/usr/bin/env python3
"""List this agent's own past sessions, newest activity first.

Each session is one JSONL transcript under
$CLAUDE_CONFIG_DIR/projects/-workspace/<session-id>.jsonl. This prints one row
per session: last activity, session id, size, and its headline — the name from
/workspace/session-metadata.json when it has one, otherwise the first user
message, which is what the Gamut UI falls back to.

Times come from the transcripts themselves, not from file mtimes, which a
container restart rewrites.

Examples:
    python3 /opt/gamut/bin/list-sessions.py
    python3 /opt/gamut/bin/list-sessions.py --since 7d
    python3 /opt/gamut/bin/list-sessions.py --grep 'weekly report'
    python3 /opt/gamut/bin/list-sessions.py --sort started --oldest-first
    python3 /opt/gamut/bin/list-sessions.py --json

Reading one of them: python3 /opt/gamut/bin/read-session.py <session-id>
"""

import argparse
import datetime as dt
import json
import os
import re
import sys

DEFAULT_CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR", "/workspace/.claude")

# User entries the CLI writes for its own bookkeeping — never something the
# user typed, so they must not become a session's headline.
NOISE_PREFIXES = (
    "<command-name>",
    "<command-message>",
    "<local-command-stdout>",
    "<user-prompt-submit-hook>",
    "Caveat: The messages below were generated",
    "[SYSTEM] ",  # container-injected notice, not something the user typed
)
SYSTEM_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)


def sessions_dir(explicit):
    """Resolve the directory holding the transcripts.

    Normally $CLAUDE_CONFIG_DIR/projects/-workspace (the slug of the /workspace
    cwd). If that is missing but `projects/` holds exactly one directory, use
    it — a session started with a different working directory lands under a
    different slug.
    """
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


def load_metadata(directory):
    """Names and stars the app keeps for these sessions, keyed by session id.

    Lives at <workspace>/session-metadata.json, three levels above the
    transcript directory (<workspace>/.claude/projects/-workspace). Absent on a
    workspace the app has never named a session in — that is not an error.
    """
    workspace = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(directory))))
    path = os.path.join(workspace, "session-metadata.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def clean_text(text):
    """Strip injected reminder blocks and collapse whitespace to one line."""
    text = SYSTEM_REMINDER_RE.sub("", text)
    return " ".join(text.split())


TIMESTAMP_RE = re.compile(r'"timestamp":"(\d{4}-\d\d-\d\dT[\d:.]+Z?)"')
TAIL_BYTES = 256 * 1024


def session_times(path, size):
    """(started, last_activity) as ISO strings, read from the transcript itself.

    Deliberately NOT the file's mtime: restarting the container rewrites every
    transcript (a resume re-appends the prior history), which stamps them all
    with the restart time and destroys the ordering. The transcript's own
    timestamps survive that.

    The last timestamp is the MAX over a tail window rather than the final
    line, because a resume's replayed lines carry their original timestamps and
    can therefore sit after newer ones.
    """
    started = last = None
    try:
        with open(path, "rb") as handle:
            for raw in handle:
                match = TIMESTAMP_RE.search(raw.decode("utf-8", "replace"))
                if match:
                    started = match.group(1)
                    break
            handle.seek(max(0, size - TAIL_BYTES))
            tail = handle.read().decode("utf-8", "replace")
        stamps = TIMESTAMP_RE.findall(tail)
        if stamps:
            last = max(stamps)
    except OSError:
        return None, None
    return started, last or started


def first_user_message(path, max_lines=400):
    """First user-typed message in a transcript, or None.

    Reads only until one is found. Mirrors the host's session-naming rule
    (first `user` entry whose content is a plain string), plus `queued_command`
    attachments, which is how the CLI records a message sent mid-turn.
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                if index >= max_lines:
                    return None
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("isSidechain"):
                    continue  # subagent traffic, not the user

                content = None
                if entry.get("type") == "user":
                    content = entry.get("message", {}).get("content")
                elif entry.get("type") == "attachment":
                    attachment = entry.get("attachment") or {}
                    if (
                        attachment.get("type") == "queued_command"
                        and attachment.get("commandMode") == "prompt"
                        and not attachment.get("isMeta")
                    ):
                        content = attachment.get("prompt")

                if not isinstance(content, str):
                    continue
                text = clean_text(content)
                if not text or text.startswith(NOISE_PREFIXES):
                    continue
                return text
    except OSError:
        return None
    return None


def parse_since(spec):
    """`7d` / `24h` / `30m` / `2026-08-01` -> a UTC cutoff datetime."""
    match = re.fullmatch(r"(\d+)([dhm])", spec)
    if match:
        amount, unit = int(match.group(1)), match.group(2)
        delta = {"d": dt.timedelta(days=amount),
                 "h": dt.timedelta(hours=amount),
                 "m": dt.timedelta(minutes=amount)}[unit]
        return dt.datetime.now(dt.timezone.utc) - delta
    try:
        parsed = dt.datetime.fromisoformat(spec)
    except ValueError:
        raise SystemExit(f"--since: expected 7d / 24h / 30m / YYYY-MM-DD, got {spec!r}")
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def iso_to_utc(value):
    """Parse a transcript timestamp (`…Z`) into an aware UTC datetime."""
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def count_matches(path, pattern):
    """How many times the pattern occurs in the transcript. Streams — files get large.

    A count rather than a bool because a common term matches nearly every
    session; the count is what separates "the conversation about X" from the
    ones that merely mention it, and ranking by it saves the caller from
    hand-rolling a `grep -c` pass.
    """
    total = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                total += len(pattern.findall(line))
    except OSError:
        return 0
    return total


def human_size(size):
    for unit in ("B", "K", "M", "G"):
        if size < 1024 or unit == "G":
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024.0


def main():
    parser = argparse.ArgumentParser(
        description="List this agent's past sessions, newest activity first.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--limit", type=int, default=30,
                        help="max sessions to show (default 30, 0 = all)")
    parser.add_argument("--since", metavar="SPEC",
                        help="only sessions active since 7d / 24h / 30m / YYYY-MM-DD")
    parser.add_argument("--grep", metavar="PATTERN",
                        help="only sessions whose transcript matches this regex")
    parser.add_argument("--sort", choices=("activity", "started"), default="activity",
                        help="order by last activity (default) or by when the session started")
    parser.add_argument("--oldest-first", action="store_true",
                        help="reverse the order so the oldest session comes first")
    parser.add_argument("--json", action="store_true",
                        help="emit JSON instead of a table")
    parser.add_argument("--dir", metavar="DIR",
                        help="transcript directory (default: $CLAUDE_CONFIG_DIR/projects/-workspace)")
    args = parser.parse_args()

    directory = sessions_dir(args.dir)
    if not os.path.isdir(directory):
        raise SystemExit(f"No transcript directory at {directory}")

    cutoff = parse_since(args.since) if args.since else None
    pattern = re.compile(args.grep, re.IGNORECASE) if args.grep else None
    metadata = load_metadata(directory)

    rows = []
    for name in os.listdir(directory):
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(directory, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        # UTC, because the timestamps inside a transcript are UTC ISO strings.
        # Local time here would print a different clock for the same session
        # than read-session.py does, which is worse than an unfamiliar zone.
        started, last_activity = session_times(path, stat.st_size)
        if last_activity is None:
            # No usable timestamps (empty or unparseable) — mtime is all there is.
            fallback = dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc)
            started = last_activity = fallback.isoformat(timespec="seconds")
        if cutoff and iso_to_utc(last_activity) < cutoff:
            continue
        matches = count_matches(path, pattern) if pattern else None
        if pattern and not matches:
            continue
        session_id = name[: -len(".jsonl")]
        meta = metadata.get(session_id) or {}
        rows.append({
            "session_id": session_id,
            "started": started,
            "last_activity": last_activity,
            "bytes": stat.st_size,
            "path": path,
            "name": meta.get("name") if isinstance(meta.get("name"), str) else None,
            "starred": bool(meta.get("starred")),
            "first_user_message": first_user_message(path),
            **({"matches": matches} if pattern else {}),
        })

    key = "started" if args.sort == "started" else "last_activity"
    # Under --grep the question is "which session was it", so the best match
    # leads; time only breaks ties. Without a pattern, time is the only order.
    if pattern and args.sort == "activity":
        rows.sort(key=lambda row: (row["matches"], row[key]), reverse=not args.oldest_first)
    else:
        rows.sort(key=lambda row: row[key], reverse=not args.oldest_first)
    if args.limit:
        rows = rows[: args.limit]

    if args.json:
        json.dump(rows, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return

    if not rows:
        print("No matching sessions.")
        return

    for row in rows:
        headline = row["name"] or row["first_user_message"] or "(no user message)"
        if len(headline) > 100:
            headline = headline[:99] + "…"
        star = "★ " if row["starred"] else ""
        stamp = row[key].replace("T", " ").replace("+00:00", "")[:19]
        hits = f"  {row['matches']:>4} hits" if pattern else ""
        print(f"{stamp}  {row['session_id']}  {human_size(row['bytes']):>6}{hits}  {star}{headline}")
    label = "started" if key == "started" else "last activity"
    ranked = ", best match first" if pattern and args.sort == "activity" else ""
    print(f"\n{len(rows)} session(s); times are UTC {label}{ranked}. Read one: "
          f"python3 /opt/gamut/bin/read-session.py <session-id>")
    print("If the user is trying to get back to one of these, also surface it "
          "with mcp__user-input__deliver_session (session_id only — omit "
          "agent_slug for your own sessions).")


if __name__ == "__main__":
    main()
