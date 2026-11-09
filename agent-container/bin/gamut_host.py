"""Calls from the session helpers to the app that runs this agent.

The names people give sessions in the Gamut UI are kept by the app, not in the
workspace, so the helpers ask the app for them, and ask it to rename or delete
a session. The container already holds what that takes: the app's address and
this agent's own token, which lets it act on this agent's sessions and no
other's.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request


class HostError(Exception):
    """The app refused the request or could not be reached; the message says which."""


def host_configured():
    return bool(os.environ.get("SUPERAGENT_HOST_API_URL") and os.environ.get("PROXY_TOKEN"))


def _request(method, path, body=None, timeout=10):
    if not host_configured():
        raise HostError("This container has no connection to the app "
                        "(SUPERAGENT_HOST_API_URL and PROXY_TOKEN are not set).")
    request = urllib.request.Request(
        os.environ["SUPERAGENT_HOST_API_URL"].rstrip("/") + path,
        method=method,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {os.environ['PROXY_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    # Straight to the app: a proxy configured for the agent's own web traffic
    # is not the way to the machine next door.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read()).get("error")
        except (ValueError, AttributeError):
            message = None
        raise HostError(f"{message or 'The app refused the request'} (HTTP {error.code})") from None
    except (urllib.error.URLError, OSError) as error:
        raise HostError(f"The app could not be reached: {getattr(error, 'reason', error)}") from None
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        raise HostError("The app answered with something that is not JSON") from None


def _session_path(session_id):
    return "/x-agent/sessions/" + urllib.parse.quote(session_id, safe="")


def session_names(timeout=5):
    """The names of this agent's sessions, by session id."""
    names = (_request("GET", "/x-agent/sessions", timeout=timeout) or {}).get("names")
    return names if isinstance(names, dict) else {}


def rename_session(session_id, name):
    return _request("PATCH", _session_path(session_id), {"name": name})


def delete_session(session_id):
    _request("DELETE", _session_path(session_id))
