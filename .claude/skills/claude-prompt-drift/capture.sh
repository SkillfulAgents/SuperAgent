#!/usr/bin/env bash
# Capture pure-claude baseline and/or SuperAgent overlay system prompts at the
# SDK version currently pinned in agent-container.
#
# Usage:
#   capture.sh [--model claude-opus-4-7] \
#              [--axis both|pure-claude|superagent] \
#              [--force] \
#              [--allow-dirty] \
#              [--pr <number>] \
#              [--snapshots-dir <path>] \
#              [--anthropic-api-key <key>] \
#              [--superagent-path <abs-path>]
#
# Snapshots are local-only build artifacts. Default location is `./snapshots/`
# right next to this script (gitignored). Override precedence:
#   --snapshots-dir <path>  >  $SNAPSHOTS_DIR env  >  default `<skill>/snapshots`
#
# Layout inside the snapshots root (one dir per axis):
#   pure-claude/<sdk-version>/<model>/{system,messages,tools}.md + meta.json
#   superagent/<sa-key>/<model>/{system,messages,tools}.md + meta.json
#
# superagent key shape depends on the source:
#   - default       : <sdk-version>+<sa-version>            e.g. 0.2.118+0.3.24
#   - --pr <num>    : <sdk-version>+pr<num>-<short-sha>     e.g. 0.2.118+pr73-fef927c2
#   - dirty tree    : key gets a `-dirty` suffix (allowed only with --allow-dirty)
#
# Why two roots: pure-claude only depends on (sdk_version, model); superagent
# also depends on SuperAgent's own version / commit. Sharing a single key
# would silently overwrite the superagent axis on re-capture.
#
# --pr <num> fetches `origin/pull/<num>/head` and captures against that commit
# without touching the working repo. Useful for previewing on-wire prompt
# changes a PR would land before merging it.
#
# Default --superagent-path is derived from this skill's location
# (.../<repo>/.claude/skills/claude-prompt-drift/ → <repo>).

set -euo pipefail

# Git Bash / MSYS2 rewrites POSIX-looking args to Windows paths before native
# exes (docker.exe) see them, which corrupts container-side paths like
# /proxy.mjs → C:\Program Files\Git\proxy.mjs. Exclude exactly the
# container-path prefixes used in docker args below; host sides of -v mounts
# are rendered Windows-style via hostpath() so they never look POSIX.
# Both are no-ops outside MSYS environments.
export MSYS2_ARG_CONV_EXCL="${MSYS2_ARG_CONV_EXCL:-/proxy.mjs;/out;/app}"
hostpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

MODEL="claude-opus-4-8"
AXIS="both"
FORCE="false"
ALLOW_DIRTY="false"
PR_NUMBER=""
API_KEY="dummy-for-capture"
SUPERAGENT_PATH=""
PR_WORKTREE=""
SNAPSHOTS_DIR_FLAG=""

usage() { sed -n '2,33p' "$0" | sed -E 's/^# ?//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)              MODEL="$2"; shift 2 ;;
    --axis)               AXIS="$2"; shift 2 ;;
    --force)              FORCE="true"; shift ;;
    --allow-dirty)        ALLOW_DIRTY="true"; shift ;;
    --pr)                 PR_NUMBER="$2"; shift 2 ;;
    --snapshots-dir)      SNAPSHOTS_DIR_FLAG="$2"; shift 2 ;;
    --anthropic-api-key)  API_KEY="$2"; shift 2 ;;
    --superagent-path)    SUPERAGENT_PATH="$2"; shift 2 ;;
    -h|--help)            usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"

# Snapshot location precedence: --snapshots-dir > $SNAPSHOTS_DIR > default
# (skill-local `snapshots/`, gitignored).
SNAPSHOTS_DIR="${SNAPSHOTS_DIR_FLAG:-${SNAPSHOTS_DIR:-$SKILL_DIR/snapshots}}"

if [[ -n "$PR_NUMBER" && -n "$SUPERAGENT_PATH" ]]; then
  echo "error: --pr and --superagent-path are mutually exclusive" >&2
  exit 2
fi

if [[ -n "$PR_NUMBER" ]]; then
  [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "error: --pr expects a number, got '$PR_NUMBER'" >&2; exit 2; }

  PR_WORKTREE="/tmp/superagent-pr-$PR_NUMBER"
  echo "[capture] fetching pull/$PR_NUMBER/head from origin..."
  git -C "$REPO_ROOT" fetch origin "pull/$PR_NUMBER/head:refs/cprompt-drift/pr/$PR_NUMBER" --force >/dev/null 2>&1 \
    || { echo "error: failed to fetch origin pull/$PR_NUMBER/head" >&2; exit 2; }

  if [[ -d "$PR_WORKTREE" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$PR_WORKTREE" >/dev/null 2>&1 || rm -rf "$PR_WORKTREE"
  fi
  git -C "$REPO_ROOT" worktree add --detach "$PR_WORKTREE" "refs/cprompt-drift/pr/$PR_NUMBER" >/dev/null \
    || { echo "error: failed to create worktree at $PR_WORKTREE" >&2; exit 2; }

  SUPERAGENT_PATH="$PR_WORKTREE"
fi

if [[ -z "$SUPERAGENT_PATH" ]]; then
  SUPERAGENT_PATH="$REPO_ROOT"
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

SA_VERSION=$(jq -r '.version // empty' "$SUPERAGENT_PATH/package.json" 2>/dev/null)
if [[ -z "$SA_VERSION" ]]; then
  echo "error: could not read .version from $SUPERAGENT_PATH/package.json" >&2
  exit 2
fi
SA_COMMIT=$(git -C "$SUPERAGENT_PATH" rev-parse --short HEAD 2>/dev/null || echo "unknown")
SA_DIRTY="false"
if [[ -n "$(git -C "$SUPERAGENT_PATH" status --porcelain 2>/dev/null || true)" ]]; then
  SA_DIRTY="true"
fi

SA_KEY_SUFFIX=""
if [[ "$SA_DIRTY" == "true" ]]; then
  SA_KEY_SUFFIX="-dirty"
fi

if [[ -n "$PR_NUMBER" ]]; then
  SA_KEY="${SDK_VERSION}+pr${PR_NUMBER}-${SA_COMMIT}${SA_KEY_SUFFIX}"
else
  SA_KEY="${SDK_VERSION}+${SA_VERSION}${SA_KEY_SUFFIX}"
fi

mkdir -p "$SNAPSHOTS_DIR"
SNAPSHOTS_DIR="$(cd "$SNAPSHOTS_DIR" && pwd)"
PURE_ROOT="$SNAPSHOTS_DIR/pure-claude/$SDK_VERSION"
SA_ROOT="$SNAPSHOTS_DIR/superagent/$SA_KEY"

IMAGE_TAG="superagent-container:drift-check"

echo "[capture] SDK version  : $SDK_VERSION"
echo "[capture] SA version   : $SA_VERSION"
echo "[capture] SA commit    : $SA_COMMIT (dirty=$SA_DIRTY)"
[[ -n "$PR_NUMBER" ]] && echo "[capture] source       : PR #$PR_NUMBER (worktree $PR_WORKTREE)"
echo "[capture] snapshots    : $SNAPSHOTS_DIR"
echo "[capture] model        : $MODEL"
echo "[capture] axis         : $AXIS"
echo "[capture] pure-claude  : $PURE_ROOT"
echo "[capture] superagent   : $SA_ROOT"

if [[ "$SA_DIRTY" == "true" && "$ALLOW_DIRTY" != "true" ]]; then
  if [[ "$AXIS" == "superagent" || "$AXIS" == "both" ]]; then
    echo "error: SuperAgent working tree is dirty — refuse to capture superagent axis." >&2
    echo "       commit/stash changes, or pass --allow-dirty (snapshot key gets a '-dirty' suffix and should NOT be committed)." >&2
    exit 2
  fi
fi

NET_NAME="claude-drift-$$"
PROXY_NAME="proxy-$$"
SA_NAME="superagent-$$"
BASELINE_NAME="baseline-$$"

cleanup() {
  local rc=$?
  set +e
  docker rm -f "$PROXY_NAME" "$SA_NAME" "$BASELINE_NAME" >/dev/null 2>&1
  docker network rm "$NET_NAME" >/dev/null 2>&1
  if [[ -n "$PR_WORKTREE" && -d "$PR_WORKTREE" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$PR_WORKTREE" >/dev/null 2>&1 || rm -rf "$PR_WORKTREE"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

docker network create "$NET_NAME" >/dev/null

sanitize_model() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
MODEL_DIR=$(sanitize_model "$MODEL")

build_image_once() {
  # Always invoke docker build — image tag is not content-addressed, so a stale
  # tag from an earlier capture (different branch / different --superagent-path)
  # would otherwise be silently reused. Docker's own layer cache makes this fast
  # when the build context hasn't changed.
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
    -v "$(hostpath "$SKILL_DIR/proxy.mjs"):/proxy.mjs:ro" \
    -v "$(hostpath "$out_dir"):/out" \
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
  [[ -f "$out_dir/$MODEL_DIR/system.md" ]]
}

write_pure_meta() {
  cat > "$PURE_ROOT/meta.json" <<EOF
{
  "sdk_version": "$SDK_VERSION",
  "model": "$MODEL",
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

write_sa_meta() {
  local source_json='"main"'
  if [[ -n "$PR_NUMBER" ]]; then
    source_json="\"pr/$PR_NUMBER\""
  fi
  cat > "$SA_ROOT/meta.json" <<EOF
{
  "sdk_version": "$SDK_VERSION",
  "superagent_version": "$SA_VERSION",
  "superagent_commit": "$SA_COMMIT",
  "superagent_dirty": $SA_DIRTY,
  "source": $source_json,
  "model": "$MODEL",
  "captured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

capture_superagent() {
  if axis_already_captured "$SA_ROOT" && [[ "$FORCE" != "true" ]]; then
    echo "[skip] superagent/$SA_KEY/$MODEL already captured (use --force to redo)"
    return
  fi
  rm -rf "$SA_ROOT"
  mkdir -p "$SA_ROOT"

  start_proxy "$SA_ROOT"

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

  wait_for_capture "$SA_ROOT" 60
  rm -f "$SA_ROOT/.seen-models.json"
  write_sa_meta
  echo "[capture] superagent capture done → $SA_ROOT/$MODEL_DIR"

  docker rm -f "$SA_NAME" >/dev/null 2>&1 || true
  stop_proxy
}

capture_pure_claude() {
  if axis_already_captured "$PURE_ROOT" && [[ "$FORCE" != "true" ]]; then
    echo "[skip] pure-claude/$SDK_VERSION/$MODEL already captured (use --force to redo)"
    return
  fi
  rm -rf "$PURE_ROOT"
  mkdir -p "$PURE_ROOT"

  start_proxy "$PURE_ROOT"

  echo "[capture] running pure-claude baseline (inside agent-container image, CMD overridden)..."
  docker run --rm \
    --name "$BASELINE_NAME" \
    --network "$NET_NAME" \
    -v "$(hostpath "$SKILL_DIR/pure-baseline/run.mjs"):/app/baseline-driver.mjs:ro" \
    -e ANTHROPIC_API_KEY="$API_KEY" \
    -e ANTHROPIC_BASE_URL="http://$PROXY_NAME:9876" \
    -e DRIFT_MODEL="$MODEL" \
    --entrypoint node \
    "$IMAGE_TAG" \
    /app/baseline-driver.mjs >/dev/null 2>&1 || true

  wait_for_capture "$PURE_ROOT" 30
  rm -f "$PURE_ROOT/.seen-models.json"
  write_pure_meta
  echo "[capture] pure-claude capture done → $PURE_ROOT/$MODEL_DIR"

  stop_proxy
}

build_image_once

case "$AXIS" in
  superagent)  capture_superagent ;;
  pure-claude) capture_pure_claude ;;
  both)        capture_pure_claude; capture_superagent ;;
  *) echo "invalid --axis: $AXIS (expected: pure-claude | superagent | both)" >&2; exit 2 ;;
esac

echo
echo "[done] diff against an older snapshot with:"
echo "       $SKILL_DIR/diff.sh pure-claude <old-sdk-version> $SDK_VERSION"
echo "       $SKILL_DIR/diff.sh superagent <old-key> $SA_KEY"
echo "       (snapshots dir: $SNAPSHOTS_DIR)"
