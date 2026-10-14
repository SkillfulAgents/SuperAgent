#!/usr/bin/python3 -I
# fusermount3 for runtimes with no-new-privs, where the setuid copy cannot mount.
# start.sh runs `serve` as root and binds this file over fusermount3, so rclone runs the client side as the agent.
import json, os, re, socket, struct, subprocess, sys, threading

AGENT_UID = 1000
AGENT_GID = 1000
FUSE_SOCK = "/run/gamut/fuse.sock"
MOUNTS_DIR = "/mounts"
_NAME_RE = re.compile(r"^(?!\.\.?\Z)[^/\\\x00]+\Z")
# -I keeps Python off the agent's site-packages. start.sh starts serve with a clean env, and mount/umount get this one.
_ROOT_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}


def _run(argv, **kwargs):
    done = subprocess.run(argv, capture_output=True, timeout=10, env=_ROOT_ENV, **kwargs)
    if done.returncode != 0:
        raise ValueError(f"{argv[0]} rc={done.returncode} {done.stderr.decode(errors='replace').strip()[:500]}")


def _check_path(path):
    parent, name = os.path.split(path)
    if parent != MOUNTS_DIR or not _NAME_RE.match(name):
        raise ValueError(f"not {MOUNTS_DIR}/<name>: {path!r}")


def _mount(path, opts):
    _check_path(path)
    dfd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fuse = None
    try:
        if os.fstat(dfd).st_uid != AGENT_UID:
            raise ValueError(f"{path!r} is not the agent's folder")
        # Of rclone's options only max_read reaches the kernel. The security options are ours.
        asked = dict(o.split("=", 1) for o in opts.split(",") if "=" in o)
        fuse = os.open("/dev/fuse", os.O_RDWR)
        kernel = f"fd={fuse},rootmode=40000,user_id={AGENT_UID},group_id={AGENT_GID},nosuid,nodev"
        if asked.get("max_read", "").isdigit():
            kernel += f",max_read={asked['max_read']}"
        # Mount on the opened folder, so a symlink swapped in after the check cannot redirect it. --no-canonicalize
        # stops mount(8) resolving the fd back to a path the agent could swap.
        _run(["/usr/bin/mount", "-i", "--no-canonicalize", "-t", "fuse.rclone", "-o", kernel, "rclone", f"/proc/self/fd/{dfd}"], pass_fds=(fuse, dfd))
        return fuse
    except BaseException:
        if fuse is not None:
            os.close(fuse)
        raise
    finally:
        os.close(dfd)


def _unmount(path):
    _check_path(path)
    # Unmount the opened mount, as _mount does, so a symlink swapped in after the check cannot redirect it.
    dfd = os.open(path, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with open(f"/proc/self/fdinfo/{dfd}") as info:
            mnt_id = next(line.split()[1] for line in info if line.startswith("mnt_id:")).encode()
        with open("/proc/self/mountinfo", "rb") as table:
            row = next((r for r in (line.rstrip(b"\n").split(b" ") for line in table) if r[0] == mnt_id), None)
        if not row or row[row.index(b"-") + 1] != b"fuse.rclone" or f"user_id={AGENT_UID}".encode() not in row[-1].split(b","):
            raise ValueError(f"{path!r} is not an agent FUSE mount")
        _run(["/usr/bin/umount", "-l", "--no-canonicalize", f"/proc/self/fd/{dfd}"], pass_fds=(dfd,))
    finally:
        os.close(dfd)


def _serve_client(conn):
    fuse = None
    conn.settimeout(10)
    try:
        uid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[1]
        if uid != AGENT_UID:
            raise ValueError(f"caller uid {uid} is not the agent")
        request = json.loads(conn.makefile("rb").readline(4096))
        if request.get("op") == "unmount":
            _unmount(request["path"])
        else:
            fuse = _mount(request["path"], request.get("opts", ""))
        socket.send_fds(conn, [b'{"ok": true}'], [fuse] if fuse is not None else [])
    except Exception as error:  # every request gets a reply, so the client never waits on a dead thread
        print(f"fusermount-helper refused: {error}", file=sys.stderr, flush=True)
        conn.sendall(json.dumps({"ok": False, "error": str(error)}).encode())
    finally:
        if fuse is not None:
            os.close(fuse)
        conn.close()


def serve():
    os.makedirs(os.path.dirname(FUSE_SOCK), exist_ok=True)
    if os.path.exists(FUSE_SOCK):
        os.unlink(FUSE_SOCK)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(FUSE_SOCK)
    os.chown(FUSE_SOCK, 0, AGENT_GID)
    os.chmod(FUSE_SOCK, 0o660)
    server.listen(16)
    # The parent returns once the socket exists, so start.sh never starts the agent before the helper.
    if os.fork():
        return 0
    os.setsid()
    while True:
        conn, _ = server.accept()
        threading.Thread(target=_serve_client, args=(conn,), daemon=True).start()


def fusermount_cli(args):
    # go-fuse runs `fusermount3 <path> -o <opts>` to mount and `fusermount3 -u[z] <path>` to unmount.
    opts = args[args.index("-o") + 1] if "-o" in args else ""
    paths = [a for i, a in enumerate(args) if not a.startswith("-") and (i == 0 or args[i - 1] != "-o")]
    request = {"op": "unmount" if any(a.startswith("-u") for a in args) else "mount", "path": os.path.abspath(paths[0]), "opts": opts}
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(30)
    try:
        conn.connect(FUSE_SOCK)
        conn.sendall(json.dumps(request).encode() + b"\n")
        message, fds, _flags, _addr = socket.recv_fds(conn, 4096, 1)
    finally:
        conn.close()
    reply = json.loads(message or b"{}")
    if not reply.get("ok"):
        sys.stderr.write(f"fusermount3: {reply.get('error', 'refused')}\n")
        return 1
    if fds:
        # The caller (go-fuse) reads the handle off the socket it named in _FUSE_COMMFD.
        with socket.socket(fileno=int(os.environ["_FUSE_COMMFD"])) as comm:
            socket.send_fds(comm, [b"\0"], fds)
    return 0


if __name__ == "__main__":
    sys.exit(serve() if sys.argv[1:] == ["serve"] else fusermount_cli(sys.argv[1:]))
