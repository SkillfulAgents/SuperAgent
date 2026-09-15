#!/bin/bash
# Builds the MediaRemote adapter (https://github.com/ungive/mediaremote-adapter)
# that lets the desktop app read and control the music player on macOS.
#
# Since macOS 15.4 only Apple-signed processes may use the private MediaRemote
# framework. The adapter is a perl script, run under /usr/bin/perl, that loads a
# small framework built here. Neither is linked into the app: main spawns perl
# with both paths (src/main/music-control/darwin-mediaremote.ts).
#
# Usage: ./scripts/build-mediaremote-adapter.sh
# Needs: macOS, Xcode command line tools, cmake (brew install cmake).
#
# Output (picked up by the mac extraResources config in package.json):
#   build/mediaremote-adapter/mediaremote-adapter.pl
#   build/mediaremote-adapter/MediaRemoteAdapter.framework   (x86_64 + arm64)
#   build/mediaremote-adapter/LICENSE
#   build/mediaremote-adapter/VERSION                        (the pinned ref)

set -euo pipefail

ADAPTER_REPO="https://github.com/ungive/mediaremote-adapter.git"
# v0.7.7 (2026-09-03), BSD-3-Clause.
ADAPTER_REF="e3ff5021eb0875858bd05f48d2e9ba2e962d1cf6"

OUTPUT_DIR="build/mediaremote-adapter"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The MediaRemote adapter is macOS only; nothing to build on $(uname -s)."
  exit 0
fi

if [ -f "$OUTPUT_DIR/VERSION" ] && [ "$(cat "$OUTPUT_DIR/VERSION")" = "$ADAPTER_REF" ] \
  && [ -d "$OUTPUT_DIR/MediaRemoteAdapter.framework" ] && [ -f "$OUTPUT_DIR/mediaremote-adapter.pl" ]; then
  echo "MediaRemote adapter $ADAPTER_REF already built in $OUTPUT_DIR"
  exit 0
fi

command -v cmake >/dev/null || { echo "cmake is required: brew install cmake"; exit 1; }

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Fetching mediaremote-adapter @ $ADAPTER_REF..."
git -C "$WORK_DIR" init -q
git -C "$WORK_DIR" remote add origin "$ADAPTER_REPO"
git -C "$WORK_DIR" fetch -q --depth 1 origin "$ADAPTER_REF"
git -C "$WORK_DIR" checkout -q FETCH_HEAD

echo "Building MediaRemoteAdapter.framework..."
cmake -S "$WORK_DIR" -B "$WORK_DIR/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$WORK_DIR/build" --config Release >/dev/null

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -R "$WORK_DIR/build/MediaRemoteAdapter.framework" "$OUTPUT_DIR/"
cp "$WORK_DIR/bin/mediaremote-adapter.pl" "$OUTPUT_DIR/"
cp "$WORK_DIR/LICENSE" "$OUTPUT_DIR/"
echo "$ADAPTER_REF" > "$OUTPUT_DIR/VERSION"

echo "Checking the adapter can load..."
/usr/bin/perl "$OUTPUT_DIR/mediaremote-adapter.pl" "$(cd "$OUTPUT_DIR" && pwd)/MediaRemoteAdapter.framework" get --no-artwork >/dev/null

echo "MediaRemote adapter built: $(du -sh "$OUTPUT_DIR" | cut -f1) in $OUTPUT_DIR"
