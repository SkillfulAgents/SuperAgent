#!/usr/bin/env python3
"""Rename or delete one of this agent's own past sessions.

    python3 /opt/gamut/bin/manage-session.py rename <session-id> <new name>
    python3 /opt/gamut/bin/manage-session.py delete <session-id>

Both go through the app, which keeps each session's name and everything else
it knows about it: a rename shows in the Gamut UI at once, and a delete
removes the transcript together with the session's notifications and unread
marks. Deleting a transcript file by hand removes the session from the list
too, but leaves those behind, so prefer this.

The session id is the full id, as list-sessions.py prints it. A delete cannot
be undone. The session this command runs in, and any session that is running
or waiting for someone's answer, cannot be deleted.
"""

import argparse
import os
import sys

# The helpers' directory is read-only in the image: no bytecode cache beside them.
sys.dont_write_bytecode = True
from gamut_host import HostError, delete_session, rename_session  # noqa: E402

# The session this command is running inside (see list-sessions.py).
CURRENT_SESSION_ID = os.environ.get("GAMUT_SESSION_ID") or None


def main():
    parser = argparse.ArgumentParser(
        description="Rename or delete one of this agent's own past sessions.",
        epilog="Find a session id: python3 /opt/gamut/bin/list-sessions.py",
    )
    actions = parser.add_subparsers(dest="action", required=True)
    rename = actions.add_parser("rename", help="give a session a new name")
    rename.add_argument("session_id", metavar="SESSION_ID")
    rename.add_argument("name", metavar="NAME", nargs="+", help="the new name (1 to 200 characters)")
    delete = actions.add_parser("delete", help="delete a session for good")
    delete.add_argument("session_id", metavar="SESSION_ID")
    args = parser.parse_args()

    try:
        if args.action == "rename":
            name = " ".join(args.name).strip()
            if not name:
                raise SystemExit("The new name is empty.")
            renamed = rename_session(args.session_id, name) or {}
            print(f"Renamed {args.session_id} to \"{renamed.get('name', name)}\".")
        else:
            if args.session_id == CURRENT_SESSION_ID:
                raise SystemExit(f"{args.session_id} is THIS session, the conversation you are in "
                                 "right now. It cannot be deleted from inside itself.")
            delete_session(args.session_id)
            print(f"Deleted {args.session_id}.")
    except HostError as error:
        raise SystemExit(f"Could not {args.action} {args.session_id}: {error}")


if __name__ == "__main__":
    main()
