#!/usr/bin/env bash
# Capture both pure-claude baseline and SuperAgent overlay system prompts
# at the SDK version currently pinned in agent-container.
#
# Usage:
#   capture.sh [--model claude-opus-4-7] \
#              [--axis both|pure-claude|superagent] \
#              [--force] \
#              [--anthropic-api-key <key>] \
#              [--superagent-path <abs-path>]
#
# Default --superagent-path is derived from this skill's location
# (.../<repo>/.claude/skills/claude-prompt-drift/ → <repo>).
#
# Output:
#   snapshots/<sdk-version>/pure-claude/<model>/{system,messages,tools,raw}.{md,json}
#   snapshots/<sdk-version>/superagent/<model>/{system,messages,tools,raw}.{md,json}
#   snapshots/<sdk-version>/meta.json

set -euo pipefail

MODEL="claude-opus-4-7"
AXIS="both"
FORCE="false"
API_KEY="dummy-for-capture"
SUPERAGENT_PATH=""

usage() { sed -n '2,17p' "$0" | sed -E 's/^# ?//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)              MODEL="$2"; shift 2 ;;
    --axis)               AXIS="$2"; shift 2 ;;
    --force)              FORCE="true"; shift ;;
    --anthropic-api-key)  API_KEY="$2"; shift 2 ;;
    --superagent-path)    SUPERAGENT_PATH="$2"; shift 2 ;;
    -h|--help)            usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -z "$SUPERAGENT_PATH" ]]; then
  # SKILL_DIR is <repo>/.claude/skills/claude-prompt-drift
  SUPERAGENT_PATH="$(cd "$SKILL_DIR/../../.." && pwd)"
fi

if [[ ! -d "$SUPERAGENT_PATH/agent-container" ]]; then
  echo "error: $SUPERAGENT_PATH/agent-container not found — pass --superagent-path explicitly" >&2
  exit 2
fi

for bin in docker jq curl; do
  command -v "$bin" >/dev/null || { echo "error: $bin not on PATH" >&2; exit 2; }
done

LOCKFILE="$SUPERAGENT_PATH/agent-container/package-lock.json"
[[ -f "$LOCKFILE" ]] || { echo "error: missing $LOCKFILE" >&2; exit 2; }

SDK_VERSION=$(jq -r '.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version // empty' "$LOCKFILE")
if [[ -z "$SDK_VERSION" ]]; then
  echo "error: could not extract @anthropic-ai/claude-agent-sdk version from $LOCKFILE" >&2
  exit 2
fi

SA_COMMIT=$(cd "$SUPERAGENT_PATH" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
SNAPSHOT_ROOT="$SKILL_DIR/snapshots/$SDK_VERSION"
mkdir -p "$SNAPSHOT_ROOT"

IMAGE_TAG="superagent-container:drift-check"

echo "[capture] SDK version  : $SDK_VERSION"
echo "[capture] SA commit    : $SA_COMMIT"
echo "[capture] model        : $MODEL"
echo "[capture] axis         : $AXIS"
echo "[capture] snapshot dir : $SNAPSHOT_ROOT"

NET_NAME="claude-drift-$$"
PROXY_NAME="proxy-$$"
SA_NAME="superagent-$$"
BASELINE_NAME="baseline-$$"

cleanup() {
  local rc=$?
  set +e
  docker rm -f "$PROXY_NAME" "$SA_NAME" "$BASELINE_NAME" >/dev/null 2>&1
  docker network rm "$NET_NAME" >/dev/null 2>&1
  exit $rc
}
trap cleanup EXIT INT TERM

docker network create "$NET_NAME" >/dev/null

sanitize_model() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
MODEL_DIR=$(sanitize_model "$MODEL")

build_image_once() {
  if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 && [[ "$FORCE" != "true" ]]; then
    echo "[capture] reusing existing image $IMAGE_TAG (use --force to rebuild)"
    return
  fi
  echo "[capture] building $IMAGE_TAG from $SUPERAGENT_PATH/agent-container ..."
  docker build -q -t "$IMAGE_TAG" "$SUPERAGENT_PATH/agent-container" >/dev/null
}

start_proxy() {
  local out_dir="$1"
  mkdir -p "$out_dir"
  rm -f "$out_dir/.seen-models.json"

  docker run -d --rm \
    --name "$PROXY_NAME" \
    --network "$NET_NAME" \
    -v "$SKILL_DIR/proxy.mjs:/proxy.mjs:ro" \
    -v "$out_dir:/out" \
    node:20 \
    node /proxy.mjs --port 9876 --upstream https://api.anthropic.com --out /out >/dev/null

  for _ in $(seq 1 20); do
    if docker logs "$PROXY_NAME" 2>&1 | grep -q '\[proxy\] listening'; then
      return 0
    fi
    sleep 0.5
  done
  echo "[capture] proxy failed to start within 10s" >&2
  docker logs "$PROXY_NAME" >&2 || true
  exit 1
}

stop_proxy() { docker rm -f "$PROXY_NAME" >/dev/null 2>&1 || true; }

wait_for_capture() {
  local out_dir="$1" timeout_s="${2:-60}"
  local target="$out_dir/$MODEL_DIR/raw.json"
  for _ in $(seq 1 $((timeout_s * 2))); do
    [[ -f "$target" ]] && return 0
    sleep 0.5
  done
  echo "[capture] timeout waiting for $target" >&2
  echo "[capture] proxy logs:" >&2
  docker logs "$PROXY_NAME" 2>&1 | tail -50 >&2 || true
  return 1
}

axis_already_captured() {
  local out_dir="$1"
  [[ -f "$out_dir/$MODEL_DIR/raw.json" ]]
}

capture_superagent() {
  local out_dir="$SNAPSHOT_ROOT/superagent"
  if axis_already_captured "$out_dir" && [[ "$FORCE" != "true" ]]; then
    echo "[skip] superagent/$MODEL already captured (use --force to redo)"
    return
  fi
  rm -rf "$out_dir"

  start_proxy "$out_dir"

  echo "[capture] running agent-container..."
  docker run -d --rm \
    --name "$SA_NAME" \
    --network "$NET_NAME" \
    -e ANTHROPIC_API_KEY="$API_KEY" \
    -e ANTHROPIC_BASE_URL="http://$PROXY_NAME:9876" \
    -p 3099:3000 \
    "$IMAGE_TAG" >/dev/null

  echo "[capture] waiting for agent-container HTTP API..."
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null -X POST "http://localhost:3099/sessions" \
         -H 'content-type: application/json' -d '{}' 2>/dev/null; then
      break
    fi
    sleep 1
  done

  echo "[capture] firing model call..."
  # agent-container's POST /sessions takes initialMessage + model and triggers
  # the SDK call immediately — no separate /messages POST needed.
  local create_body
  create_body=$(jq -n --arg m "$MODEL" '{
    initialMessage: "hi",
    model: $m,
    metadata: { name: "drift-check" }
  }')

  if ! curl -fsS -X POST "http://localhost:3099/sessions" \
       -H 'content-type: application/json' \
       -d "$create_body" -o /dev/null; then
    echo "[capture] failed to create session" >&2
    docker logs "$SA_NAME" 2>&1 | tail -80 >&2 || true
    exit 1
  fi

  wait_for_capture "$out_dir" 60
  echo "[capture] superagent capture done → $out_dir/$MODEL_DIR"

  docker rm -f "$SA_NAME" >/dev/null 2>&1 || true
  stop_proxy
}

capture_pure_claude() {
  local out_dir="$SNAPSHOT_ROOT/pure-claude"
  if axis_already_captured "$out_dir" && [[ "$FORCE" != "true" ]]; then
    echo "[skip] pure-claude/$MODEL already captured (use --force to redo)"
    return
  fi
  rm -rf "$out_dir"

  start_proxy "$out_dir"

  echo "[capture] running pure-claude baseline (inside agent-container image, CMD overridden)..."
  # Mount the bare-preset driver over the image's /app/baseline-driver.mjs
  # and exec node on it. The image's /app already contains the SDK at the
  # correct version + the claude native binary on PATH.
  docker run --rm \
    --name "$BASELINE_NAME" \
    --network "$NET_NAME" \
    -v "$SKILL_DIR/pure-baseline/run.mjs:/app/baseline-driver.mjs:ro" \
    -e ANTHROPIC_API_KEY="$API_KEY" \
    -e ANTHROPIC_BASE_URL="http://$PROXY_NAME:9876" \
    --entrypoint node \
    "$IMAGE_TAG" \
    /app/baseline-driver.mjs >/dev/null 2>&1 || true

  wait_for_capture "$out_dir" 30
  echo "[capture] pure-claude capture done → $out_dir/$MODEL_DIR"

  stop_proxy
}

build_image_once

case "$AXIS" in
  superagent)  capture_superagent ;;
  pure-claude) capture_pure_claude ;;
  both)        capture_pure_claude; capture_superagent ;;
  *) echo "invalid --axis: $AXIS (expected: pure-claude | superagent | both)" >&2; exit 2 ;;
esac

cat > "$SNAPSHOT_ROOT/meta.json" <<EOF
{
  "sdk_version": "$SDK_VERSION",
  "model": "$MODEL",
  "superagent_commit": "$SA_COMMIT",
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "axis": "$AXIS"
}
EOF

echo
echo "[done] snapshot: $SNAPSHOT_ROOT"
echo "[done] diff against an older SDK version with:"
echo "       $SKILL_DIR/diff.sh <old-sdk-version> $SDK_VERSION"
