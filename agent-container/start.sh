#!/bin/sh
# Starts the agent server as claude. A runtime whose /dev/fuse is root-only
# (Apple Container) starts the image as root: open the device to all users so
# claude can mount volumes, then drop to claude. If the drop fails, so does the start.
set -e
if [ "$(id -u)" = 0 ]; then
  if [ -e /dev/fuse ]; then chmod 666 /dev/fuse; fi
  exec setpriv --reuid=claude --regid=claude --init-groups node dist/server.js
fi
exec node dist/server.js
