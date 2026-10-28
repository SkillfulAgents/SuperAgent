#!/usr/bin/env bash
# Compare two captured snapshots within a single axis.
#
# Usage:
#   diff.sh <axis> <old-key> <new-key> [--model <model>] [--snapshots-dir <path>]
#
#   axis     pure-claude | superagent
#   old-key  for pure-claude: <sdk-version>               (e.g. 0.2.118)
#            for superagent : <sdk-version>+<sa-version>  (e.g. 0.2.118+0.3.24)
#                          or <sdk-version>+pr<num>-<sha> (e.g. 0.2.118+pr73-fef927c2)
#   new-key  same format as old-key
#
# Snapshots default to `<skill>/snapshots/`. Override with --snapshots-dir
# or the SNAPSHOTS_DIR env var.
#
# Exits non-zero if any drift is found (CI-friendly).

set -euo pipefail

AXIS=""
OLD=""
NEW=""
MODEL=""
SNAPSHOTS_DIR_FLAG=""

usage() { sed -n '2,16p' "$0" | sed -E 's/^# ?//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)          MODEL="$2"; shift 2 ;;
    --snapshots-dir)  SNAPSHOTS_DIR_FLAG="$2"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *) if   [[ -z "$AXIS" ]]; then AXIS="$1"
       elif [[ -z "$OLD"  ]]; then OLD="$1"
       elif [[ -z "$NEW"  ]]; then NEW="$1"
       else echo "extra arg: $1" >&2; usage >&2; exit 2
       fi; shift ;;
  esac
done

if [[ -z "$AXIS" || -z "$OLD" || -z "$NEW" ]]; then
  echo "error: need <axis> <old-key> <new-key>" >&2
  usage >&2
  exit 2
fi

case "$AXIS" in
  pure-claude|superagent) ;;
  *) echo "invalid axis: $AXIS (expected: pure-claude | superagent)" >&2; exit 2 ;;
esac

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
SNAPSHOTS_DIR="${SNAPSHOTS_DIR_FLAG:-${SNAPSHOTS_DIR:-$SKILL_DIR/snapshots}}"

OLD_DIR="$SNAPSHOTS_DIR/$AXIS/$OLD"
NEW_DIR="$SNAPSHOTS_DIR/$AXIS/$NEW"

[[ -d "$OLD_DIR" ]] || { echo "missing snapshot: $OLD_DIR" >&2; exit 2; }
[[ -d "$NEW_DIR" ]] || { echo "missing snapshot: $NEW_DIR" >&2; exit 2; }

sanitize_model() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

echo "===================================================================="
echo " axis: $AXIS    $OLD  →  $NEW"
echo " from: $SNAPSHOTS_DIR"
echo "===================================================================="

exit_code=0
if [[ -n "$MODEL" ]]; then
  m=$(sanitize_model "$MODEL")
  diff -ruN -x 'raw.json' -x '.seen-models.json' \
    --label "$AXIS/$OLD/$m" "$OLD_DIR/$m" \
    --label "$AXIS/$NEW/$m" "$NEW_DIR/$m" || exit_code=$?
else
  diff -ruN -x 'raw.json' -x '.seen-models.json' \
    --label "$AXIS/$OLD" "$OLD_DIR" \
    --label "$AXIS/$NEW" "$NEW_DIR" || exit_code=$?
fi

echo
if [[ $exit_code -eq 0 ]]; then
  echo "[diff] no drift in $AXIS between $OLD and $NEW"
else
  echo "[diff] drift detected in $AXIS between $OLD and $NEW (see above)"
fi
exit $exit_code
