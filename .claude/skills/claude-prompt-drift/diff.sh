#!/usr/bin/env bash
# Compare two captured snapshots across one or both axes.
#
# Usage:
#   diff.sh <old-sdk-version> <new-sdk-version> \
#           [--axis pure-claude|superagent|both] \
#           [--model <model>]
#
# Exits non-zero if any drift is found (useful in CI).

set -euo pipefail

OLD=""
NEW=""
AXIS="both"
MODEL=""

usage() { sed -n '2,9p' "$0" | sed -E 's/^# ?//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --axis)    AXIS="$2"; shift 2 ;;
    --model)   MODEL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) if [[ -z "$OLD" ]]; then OLD="$1"
       elif [[ -z "$NEW" ]]; then NEW="$1"
       else echo "extra arg: $1" >&2; usage >&2; exit 2
       fi; shift ;;
  esac
done

if [[ -z "$OLD" || -z "$NEW" ]]; then
  echo "error: need <old-sdk-version> and <new-sdk-version>" >&2
  usage >&2
  exit 2
fi

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
OLD_DIR="$SKILL_DIR/snapshots/$OLD"
NEW_DIR="$SKILL_DIR/snapshots/$NEW"

[[ -d "$OLD_DIR" ]] || { echo "missing snapshot: $OLD_DIR" >&2; exit 2; }
[[ -d "$NEW_DIR" ]] || { echo "missing snapshot: $NEW_DIR" >&2; exit 2; }

sanitize_model() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

diff_axis() {
  local axis="$1"
  local old="$OLD_DIR/$axis"
  local new="$NEW_DIR/$axis"

  if [[ ! -d "$old" || ! -d "$new" ]]; then
    echo "[$axis] not captured on one side, skipping"
    return 0
  fi

  echo
  echo "===================================================================="
  echo " axis: $axis    $OLD  →  $NEW"
  echo "===================================================================="

  local exit_code=0
  if [[ -n "$MODEL" ]]; then
    local m
    m=$(sanitize_model "$MODEL")
    diff -ruN -x 'raw.json' \
      --label "$axis/$OLD/$m" "$old/$m" \
      --label "$axis/$NEW/$m" "$new/$m" || exit_code=$?
  else
    diff -ruN -x 'raw.json' \
      --label "$axis/$OLD" "$old" \
      --label "$axis/$NEW" "$new" || exit_code=$?
  fi
  return $exit_code
}

drift=0
case "$AXIS" in
  pure-claude|superagent) diff_axis "$AXIS" || drift=1 ;;
  both)
    diff_axis pure-claude || drift=1
    diff_axis superagent  || drift=1 ;;
  *) echo "invalid --axis: $AXIS" >&2; exit 2 ;;
esac

echo
if [[ $drift -eq 0 ]]; then
  echo "[diff] no drift between $OLD and $NEW"
else
  echo "[diff] drift detected between $OLD and $NEW (see above)"
fi
exit $drift
