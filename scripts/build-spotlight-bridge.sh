#!/bin/bash
# Builds the Spotlight bridge (native/macos/SpotlightBridge.swift): the dylib
# the desktop app's main process loads to put agents, sessions and dashboards
# into macOS Spotlight. See docs/spotlight.md.
#
# Usage: ./scripts/build-spotlight-bridge.sh
# Needs: macOS with the Xcode command line tools. A no-op elsewhere.
#
# Output (picked up by the mac extraResources config in package.json):
#   build/spotlight-bridge/libSpotlightBridge.dylib   (arm64 + x86_64)

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "Skipping the Spotlight bridge: macOS only."
  exit 0
fi

SOURCE="native/macos/SpotlightBridge.swift"
OUTPUT_DIR="build/spotlight-bridge"
OUTPUT="$OUTPUT_DIR/libSpotlightBridge.dylib"
# The app's minimum macOS, which is Electron's own (12, Monterey). Without it
# the dylib is stamped with the build machine's SDK version and dyld refuses
# to load it on anything older.
DEPLOYMENT_TARGET="12.0"

if [ -f "$OUTPUT" ] && [ "$OUTPUT" -nt "$SOURCE" ] && [ "$OUTPUT" -nt "$0" ]; then
  echo "Spotlight bridge is up to date: $OUTPUT"
  exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

for ARCH in arm64 x86_64; do
  xcrun swiftc -O -emit-library \
    -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
    -framework CoreSpotlight \
    -Xlinker -install_name -Xlinker @rpath/libSpotlightBridge.dylib \
    -o "$WORK_DIR/libSpotlightBridge-$ARCH.dylib" \
    "$SOURCE"
done

mkdir -p "$OUTPUT_DIR"
lipo -create -output "$OUTPUT" "$WORK_DIR"/libSpotlightBridge-*.dylib
echo "Built $OUTPUT ($(lipo -archs "$OUTPUT"))"
