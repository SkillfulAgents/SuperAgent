#!/bin/sh
# Populate NODE_COMPILE_CACHE and smoke-test dist/web/server.mjs at image build.
# Success = server stayed up until timeout (exit 124). Any other exit fails the build.
set -eu

CACHE_DIR="${NODE_COMPILE_CACHE:-/app/.compile-cache}"
mkdir -p "$CACHE_DIR"

# -k 5s: SIGTERM triggers the server's graceful shutdown; if that hangs (no
# network in the build sandbox), SIGKILL after 5s fails the build (exit 137)
# instead of hanging `docker build` forever.
set +e
SUPERAGENT_DATA_DIR=/tmp/sa-compile-warmup E2E_MOCK=true PORT=39999 \
  timeout -k 5s 12s node dist/web/server.mjs
status=$?
set -e

if [ "$status" -ne 124 ]; then
  echo "compile-cache warmup: expected timeout exit 124 (server was running), got $status" >&2
  exit 1
fi

if [ -z "$(ls -A "$CACHE_DIR")" ]; then
  echo "compile-cache warmup: $CACHE_DIR is empty" >&2
  exit 1
fi

chmod -R a+rwX "$CACHE_DIR"
rm -rf /tmp/sa-compile-warmup
