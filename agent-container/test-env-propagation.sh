#!/usr/bin/env bash
#
# Integration test: verifies env vars set on the container's process.env
# propagate to the Claude Code subprocess spawned by the Claude Agent SDK.
#
# Motivation
# ----------
# Agent SDK 0.2.113 changed the semantics of `options.env` from "overlay
# process.env" to "replace process.env". If agent-container doesn't spread
# process.env into options.env explicitly, the Claude subprocess will stop
# seeing env vars set via `docker run -e` / the /env endpoint.
#
# Three-state validation (run this script at each stage):
#   1. Pre-upgrade  (SDK 0.2.111, overlay): PASS
#   2. Post-upgrade (SDK 0.2.118, replace, no code fix): FAIL
#   3. Post-upgrade + code fix (spread process.env in claude-code.ts): PASS
#
# Requires: Docker, curl, jq, openssl, and an anthropicApiKey in the
# Superagent-Dev settings.json (macOS path below; adjust for Linux/Windows).
#
# Usage: ./test-env-propagation.sh [image-tag]
set -euo pipefail

IMAGE="${1:-superagent-container:latest}"
SETTINGS="${SUPERAGENT_SETTINGS:-$HOME/Library/Application Support/Superagent-Dev/settings.json}"
PORT="${PORT:-3401}"
CONTAINER="env-prop-test-$$"

API_KEY=$(jq -r '.apiKeys.anthropicApiKey // ""' "$SETTINGS")
if [ -z "$API_KEY" ]; then
  echo "FAIL: no apiKeys.anthropicApiKey in $SETTINGS" >&2
  exit 2
fi

NONCE="env-marker-$(openssl rand -hex 8)"

cleanup() {
  docker logs "$CONTAINER" >/tmp/env-prop-container.log 2>&1 || true
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm   "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> booting $IMAGE with SUPERAGENT_TEST_MARKER=$NONCE on :$PORT"
docker run -d --name "$CONTAINER" -p "$PORT:3000" \
  -e ANTHROPIC_API_KEY="$API_KEY" \
  -e SUPERAGENT_TEST_MARKER="$NONCE" \
  "$IMAGE" >/dev/null

echo "==> waiting for /health"
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://localhost:$PORT/health" >/dev/null || { echo "FAIL: container never became healthy" >&2; exit 1; }

# Prompt: force a Bash tool call so we exercise the Claude subprocess's env.
# Deliberately do NOT include the nonce in the prompt — Claude has to read
# it from the env to mention it back, so a match in the output proves the
# subprocess saw SUPERAGENT_TEST_MARKER.
PROMPT='Run this exact bash command and then reply with only its output on a single line, nothing else:

printf "MARKER=%s" "$SUPERAGENT_TEST_MARKER"

If the variable is unset or empty, reply with exactly: MARKER=<unset>'

echo "==> creating session"
CREATE_RESP=$(curl -sf -X POST "http://localhost:$PORT/sessions" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg m "$PROMPT" '{initialMessage:$m, model:"claude-haiku-4-5-20251001"}')")
SESSION_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')
[ -n "$SESSION_ID" ] || { echo "FAIL: could not create session. Response: $CREATE_RESP" >&2; exit 1; }
echo "==> session $SESSION_ID"

echo "==> polling for assistant reply referencing the marker"
DEADLINE=$(( $(date +%s) + 120 ))
LAST_DUMP=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  MSGS=$(curl -sf "http://localhost:$PORT/sessions/$SESSION_ID/messages" || echo '[]')
  LAST_DUMP="$MSGS"

  # PASS: the nonce appears anywhere in assistant/result output — the subprocess saw the var.
  if printf '%s' "$MSGS" | grep -q "MARKER=$NONCE"; then
    echo "PASS: Claude subprocess saw SUPERAGENT_TEST_MARKER=$NONCE"
    exit 0
  fi

  # FAIL-FAST: Claude explicitly reported the var as unset.
  if printf '%s' "$MSGS" | grep -q 'MARKER=<unset>'; then
    echo "FAIL: Claude subprocess did NOT see SUPERAGENT_TEST_MARKER (reply said MARKER=<unset>)" >&2
    echo "$MSGS" | jq '[.[] | select(.type=="assistant" or .type=="result")]' >&2 || true
    exit 1
  fi

  # FAIL-FAST: SDK emitted a final result that doesn't contain the marker.
  if printf '%s' "$MSGS" | jq -e 'any(.[]; .type=="result")' >/dev/null 2>&1; then
    echo "FAIL: result message emitted without marker match" >&2
    echo "$MSGS" | jq '[.[] | select(.type=="assistant" or .type=="result")]' >&2 || true
    exit 1
  fi

  sleep 2
done

echo "FAIL: timed out after 120s waiting for assistant reply" >&2
printf '%s\n' "$LAST_DUMP" | jq '[.[] | {type, subtype: (.subtype // null)}]' >&2 || true
echo "(full container logs written to /tmp/env-prop-container.log)" >&2
exit 1
