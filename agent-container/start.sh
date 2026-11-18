#!/bin/sh
# Starts the agent server as claude. A runtime whose /dev/fuse is root-only
# (Apple Container) starts the image as root: open the device to all users so
# claude can mount volumes, then drop to claude. If the drop fails, so does the start.
set -e
if [ "$(id -u)" = 0 ]; then
  if [ -e /dev/fuse ]; then chmod 666 /dev/fuse; fi
  # No-new-privs (Lambda MicroVM) disables the setuid fusermount3, so a root helper mounts instead.
  # A helper that fails to start leaves volumes unmounted, not the agent down.
  if [ -n "$SUPERAGENT_VOLUMES" ] && grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status; then
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/local/lib/gamut/fusermount-helper serve && mount --bind /usr/local/lib/gamut/fusermount-helper /usr/local/bin/fusermount3 ||
      echo "fusermount helper unavailable, volumes will not mount" >&2
  fi
  exec setpriv --reuid=claude --regid=claude --init-groups node dist/server.js
fi
exec node dist/server.js
