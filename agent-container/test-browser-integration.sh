#!/usr/bin/env bash
#
# Integration tests for the agent-browser browser endpoints.
# Requires: Docker, curl, jq
# Usage: ./test-browser-integration.sh
#
# Tests both the local browser path (Chrome inside container) and the
# host browser path (Chrome connected via --cdp).
#
set -euo pipefail

CONTAINER_NAME="ab-integration-test-$$"
PORT=3399
PASS=0
FAIL=0
IMAGE="${1:-superagent-container}"
RESP_FILE=$(mktemp)

cleanup() {
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
  rm -f "$RESP_FILE"
}
trap cleanup EXIT

assert_json() {
  local label="$1" field="$2" expected="$3"
  local actual
  actual=$(jq -r "$field" < "$RESP_FILE" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (expected $field=$expected, got $actual)"
    echo "    Response: $(cat "$RESP_FILE")"
    FAIL=$((FAIL + 1))
  fi
}

post() {
  curl -sf -X POST "http://localhost:$PORT$1" \
    -H 'Content-Type: application/json' \
    -d "$2" \
    -o "$RESP_FILE" 2>/dev/null || echo '{"error":"curl failed"}' > "$RESP_FILE"
}

get() {
  curl -sf "http://localhost:$PORT$1" \
    -o "$RESP_FILE" 2>/dev/null || echo '{"error":"curl failed"}' > "$RESP_FILE"
}

echo "=== Agent-Browser Integration Tests ==="
echo "Image: $IMAGE"
echo ""

# ─── Start container ───────────────────────────────────────────────
echo "Starting container..."
docker run -d --name "$CONTAINER_NAME" -p "$PORT:3000" \
  -e ANTHROPIC_API_KEY=fake \
  --init \
  "$IMAGE" >/dev/null

# Wait for health
for i in $(seq 1 10); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""

# ─── Test 1: Local Browser Path ───────────────────────────────────
echo "── Local Browser Path ──"

post /browser/open '{"sessionId":"local","url":"https://example.com"}'
assert_json "open" ".success" "true"

post /browser/snapshot '{"sessionId":"local","interactive":true,"compact":true}'
assert_json "snapshot returns text" "(.snapshot | length > 0)" "true"
assert_json "snapshot has tabCount" "(.tabCount | type)" "number"

post /browser/click '{"sessionId":"local","ref":"@e1"}'
assert_json "click" ".success" "true"

post /browser/screenshot '{"sessionId":"local"}'
assert_json "screenshot" ".success" "true"

# tab new — previously required a workaround in 0.12.0
post /browser/run '{"sessionId":"local","command":"tab new https://example.org"}'
assert_json "tab new (no workaround)" ".success" "true"
assert_json "tab new returns tabInfo" ".tabInfo.tabCount" "2"

post /browser/run '{"sessionId":"local","command":"tab"}'
assert_json "tab list" ".success" "true"

post /browser/run '{"sessionId":"local","command":"get url"}'
assert_json "get url" ".success" "true"

post /browser/run '{"sessionId":"local","command":"eval document.title"}'
assert_json "eval" ".success" "true"

post /browser/close '{"sessionId":"local"}'
assert_json "close" ".success" "true"

get /browser/status
assert_json "status inactive" ".active" "false"

echo ""

# ─── Test 2: Host Browser Path (--cdp) ────────────────────────────
echo "── Host Browser Path (--cdp simulation) ──"

# Start a separate Chrome inside the container to simulate a host browser.
# Find Chrome binary dynamically — it may be in agent-browser's cache (x86_64)
# or in Playwright's cache (ARM64).
docker exec "$CONTAINER_NAME" bash -c '
  CHROME=$(find /home/claude/.agent-browser/browsers /opt/playwright-browsers -name chrome -type f 2>/dev/null | head -1)
  if [ -z "$CHROME" ]; then echo "No Chrome binary found" >&2; exit 1; fi
  "$CHROME" --headless --no-sandbox --disable-gpu \
    --remote-debugging-port=9444 \
    --user-data-dir=/tmp/host-profile &
  for i in $(seq 1 10); do
    curl -sf http://localhost:9444/json/version >/dev/null 2>&1 && break
    sleep 1
  done
' 2>/dev/null

# Get CDP URL
CDP_WS=$(docker exec "$CONTAINER_NAME" \
  curl -sf http://localhost:9444/json/version 2>/dev/null | jq -r .webSocketDebuggerUrl)

if [[ -z "$CDP_WS" || "$CDP_WS" == "null" ]]; then
  echo "  ✗ Could not get CDP WebSocket URL for host browser simulation"
  FAIL=$((FAIL + 1))
else
  # Test agent-browser --cdp directly (what execBrowser does in host mode)
  docker exec "$CONTAINER_NAME" timeout 15 \
    agent-browser open https://example.com --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp open" ".success" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser snapshot --cdp "$CDP_WS" -i -c --json > "$RESP_FILE" 2>&1
  assert_json "cdp snapshot" ".success" "true"
  assert_json "cdp snapshot has refs" "(.data.refs | keys | length > 0)" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser click '@e1' --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp click" ".success" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser tab new https://example.org --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp tab new" ".success" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser close --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp close" ".success" "true"

  # Kill the simulated host Chrome
  docker exec "$CONTAINER_NAME" pkill -f "remote-debugging-port=9444" 2>/dev/null || true
fi

echo ""

# ─── Summary ──────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed ==="
if [[ $FAIL -gt 0 ]]; then
  echo "FAILED"
  exit 1
else
  echo "ALL PASSED"
fi
