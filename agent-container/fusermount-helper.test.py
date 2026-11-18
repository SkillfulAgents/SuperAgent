import importlib.util, io, json, os, shutil, socket, tempfile, threading, unittest
from unittest.mock import patch

_spec = importlib.util.spec_from_file_location("helper", os.path.join(os.path.dirname(__file__), "fusermount-helper.py"))
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)


class FusermountHelperTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.mounts = os.path.join(self.root, "mounts")
        os.makedirs(self.mounts)
        self.addCleanup(shutil.rmtree, self.root, True)
        for name, value in (("MOUNTS_DIR", self.mounts), ("AGENT_UID", os.getuid()), ("FUSE_SOCK", os.path.join(self.root, "fuse.sock"))):
            patcher = patch.object(helper, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _folder(self, name="Team Drive"):
        path = os.path.join(self.mounts, name)
        os.mkdir(path)
        return path

    def test_cli_reads_go_fuse_argument_order_and_relays_the_handle(self):
        # go-fuse runs `fusermount3 <path> -o <opts>` and reads the handle off _FUSE_COMMFD.
        server = socket.socket(socket.AF_UNIX)
        server.bind(helper.FUSE_SOCK)
        server.listen(1)
        requests = []

        def answer():
            conn, _ = server.accept()
            requests.append(json.loads(conn.makefile("rb").readline()))
            with open(os.devnull) as handle:
                socket.send_fds(conn, [b'{"ok": true}'], [handle.fileno()])
            conn.close()

        threading.Thread(target=answer, daemon=True).start()
        ours, theirs = socket.socketpair()
        with patch.dict(os.environ, {"_FUSE_COMMFD": str(theirs.detach())}):
            rc = helper.fusermount_cli(["/mounts/Team Drive", "-o", "fsname=x,max_read=1048576"])
        _msg, fds, _, _ = socket.recv_fds(ours, 16, 1)
        server.close()
        ours.close()
        for fd in fds:
            os.close(fd)
        self.assertEqual(rc, 0)
        self.assertEqual(requests, [{"op": "mount", "path": "/mounts/Team Drive", "opts": "fsname=x,max_read=1048576"}])
        self.assertEqual(len(fds), 1)

    def test_mount_refuses_paths_outside_one_mounts_folder(self):
        for path in ("/etc", f"{self.mounts}/../etc", f"{self.mounts}/a/b", f"{self.mounts}/..", self.mounts):
            with self.subTest(path=path), self.assertRaises(ValueError):
                helper._mount(path, "")

    def test_mount_refuses_a_symlink_and_a_folder_the_agent_does_not_own(self):
        os.symlink(self.root, os.path.join(self.mounts, "evil"))
        with self.assertRaises(OSError):
            helper._mount(os.path.join(self.mounts, "evil"), "")
        path = self._folder()
        with patch.object(helper, "AGENT_UID", os.getuid() + 1), self.assertRaises(ValueError):
            helper._mount(path, "")

    def test_mount_keeps_its_own_security_options_and_passes_only_max_read(self):
        path = self._folder()
        real_open = os.open
        calls = []

        def fake_open(p, flags, *a):
            return real_open(os.devnull, os.O_RDWR) if p == "/dev/fuse" else real_open(p, flags, *a)

        with patch.object(helper.os, "open", side_effect=fake_open), patch.object(helper, "_run", side_effect=lambda argv, **kw: calls.append(argv)):
            fuse = helper._mount(path, "allow_other,fsname=:webdav{x}:,subtype=rclone,max_read=1048576,suid")
        os.close(fuse)
        argv = calls[0]
        self.assertEqual(argv[:5], ["/usr/bin/mount", "-i", "--no-canonicalize", "-t", "fuse.rclone"])
        self.assertTrue(argv[6].endswith(",nosuid,nodev,max_read=1048576"))
        self.assertNotIn("allow_other", argv[6])
        self.assertEqual(argv[7], "rclone")
        self.assertTrue(argv[8].startswith("/proc/self/fd/"))

    @unittest.skipUnless(hasattr(os, "O_PATH"), "Linux only")
    def test_unmount_only_an_agent_fuse_mount_under_mounts(self):
        path = self._folder()
        uid = os.getuid()
        at = path.replace(" ", "\\040")  # as the kernel writes it
        table = (
            f"36 25 0:40 / {at} rw - fuse.rclone x rw,user_id={uid},group_id=1000\n"
            f"37 25 0:41 / {at} rw - ext4 /dev/vda rw\n"
            f"38 25 0:42 / {at} rw - fuse.rclone x rw,user_id={uid}0,group_id=1000\n"
            f"39 25 0:43 / {at} rw - fuseblk x rw,user_id={uid},group_id=1000\n"
            # The kernel leaves a vertical tab unescaped: split on any whitespace and this ext4 row reads as fuse.rclone.
            f"40 25 0:44 / {self.mounts}/a\v-\vfuse.rclone rw - ext4 /dev/vda rw,user_id={uid}\n"
        ).encode()
        real_open = open

        def opener(mnt_id):
            def fake_open(p, *a, **k):
                if p == "/proc/self/mountinfo":
                    return io.BytesIO(table)
                if str(p).startswith("/proc/self/fdinfo/"):
                    return io.StringIO(f"pos:\t0\nmnt_id:\t{mnt_id}\n")
                return real_open(p, *a, **k)
            return fake_open

        for mnt_id, allowed in (("36", True), ("37", False), ("38", False), ("39", False), ("40", False)):
            with self.subTest(mnt_id=mnt_id), patch("builtins.open", side_effect=opener(mnt_id)), patch.object(helper, "_run") as run:
                if allowed:
                    helper._unmount(path)
                    self.assertEqual(run.call_args.args[0][:3], ["/usr/bin/umount", "-l", "--no-canonicalize"])
                    self.assertTrue(run.call_args.args[0][3].startswith("/proc/self/fd/"))
                else:
                    with self.assertRaises(ValueError):
                        helper._unmount(path)
                    run.assert_not_called()
        os.symlink(self.root, os.path.join(self.mounts, "evil"))
        with self.assertRaises(OSError):
            helper._unmount(os.path.join(self.mounts, "evil"))
        with self.assertRaises(ValueError):
            helper._unmount("/workspace")

    def test_runs_isolated_so_root_never_loads_the_agents_python_files(self):
        with open(_spec.origin) as source:
            self.assertEqual(source.readline().strip(), "#!/usr/bin/python3 -I")

    def test_root_commands_get_a_fixed_env_not_the_agents(self):
        with patch.object(helper.subprocess, "run") as run:
            run.return_value.returncode = 0
            helper._run(["/usr/bin/umount", "-l", "/mounts/x"])
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})

    @unittest.skipUnless(hasattr(socket, "SO_PEERCRED"), "Linux only")
    def test_server_refuses_a_caller_that_is_not_the_agent(self):
        client, server = socket.socketpair()
        with patch.object(helper, "AGENT_UID", os.getuid() + 1):
            client.sendall(json.dumps({"op": "mount", "path": "/mounts/x"}).encode() + b"\n")
            helper._serve_client(server)
        self.assertFalse(json.loads(client.recv(4096))["ok"])


if __name__ == "__main__":
    unittest.main()
