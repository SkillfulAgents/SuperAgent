#!/bin/bash
# Builds the Swift bridges in native/macos/ that the desktop app's main process
# loads with koffi:
#   - SpotlightBridge: agents, sessions and dashboards in macOS Spotlight.
#     See docs/spotlight.md.
#   - NotificationBridge: whether the user turned off the app's notifications.
#
# Usage: ./scripts/build-macos-bridges.sh
# Needs: macOS with the Xcode command line tools. A no-op elsewhere.
#
# Output (picked up by the mac extraResources config in package.json):
#   build/spotlight-bridge/libSpotlightBridge.dylib         (arm64 + x86_64)
#   build/notification-bridge/libNotificationBridge.dylib   (arm64 + x86_64)

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "Skipping the macOS bridges: macOS only."
  exit 0
fi

# The app's minimum macOS, which is Electron's own (12, Monterey). Without it
# the dylib is stamped with the build machine's SDK version and dyld refuses
# to load it on anything older.
DEPLOYMENT_TARGET="12.0"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Arguments: bridge name, output directory, framework to link.
build_bridge() {
  local name="$1" output_dir="$2" framework="$3"
  local source="native/macos/$name.swift"
  local output="$output_dir/lib$name.dylib"

  if [ -f "$output" ] && [ "$output" -nt "$source" ] && [ "$output" -nt "$0" ]; then
    echo "$name is up to date: $output"
    return
  fi

  for arch in arm64 x86_64; do
    xcrun swiftc -O -emit-library \
      -target "$arch-apple-macos$DEPLOYMENT_TARGET" \
      -framework "$framework" \
      -Xlinker -install_name -Xlinker "@rpath/lib$name.dylib" \
      -o "$WORK_DIR/lib$name-$arch.dylib" \
      "$source"
  done

  mkdir -p "$output_dir"
  lipo -create -output "$output" "$WORK_DIR/lib$name"-*.dylib
  echo "Built $output ($(lipo -archs "$output"))"
}

build_bridge SpotlightBridge build/spotlight-bridge CoreSpotlight
build_bridge NotificationBridge build/notification-bridge UserNotifications
