#!/bin/bash
# Builds the macOS bridges: the Swift dylibs the desktop app's main process
# loads through koffi.
#   - Spotlight (native/macos/SpotlightBridge.swift) puts agents, sessions and
#     dashboards into macOS Spotlight. See docs/spotlight.md.
#   - Notification (native/macos/NotificationBridge.swift) reads whether the
#     user turned off the app's notifications.
#   - Glass (native/macos/GlassBridge.swift) draws Liquid Glass behind the
#     quick-dispatch launcher.
#
# Usage: ./scripts/build-spotlight-bridge.sh
# Needs: macOS with the Xcode command line tools. A no-op elsewhere.
#
# Output (picked up by the mac extraResources config in package.json):
#   build/spotlight-bridge/libSpotlightBridge.dylib         (arm64 + x86_64)
#   build/notification-bridge/libNotificationBridge.dylib   (arm64 + x86_64)
#   build/glass-bridge/libGlassBridge.dylib                 (arm64 + x86_64)

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "Skipping the macOS bridges: macOS only."
  exit 0
fi

# The app's minimum macOS, which is Electron's own (12, Monterey). Without it
# the dylib is stamped with the build machine's SDK version and dyld refuses
# to load it on anything older.
DEPLOYMENT_TARGET="12.0"

# name | framework | output dir, one bridge per line. Builds
# native/macos/<name>.swift into build/<output dir>/lib<name>.dylib.
BRIDGES="
SpotlightBridge|CoreSpotlight|spotlight-bridge
NotificationBridge|UserNotifications|notification-bridge
GlassBridge|AppKit|glass-bridge
"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

for BRIDGE in $BRIDGES; do
  IFS='|' read -r NAME FRAMEWORK DIR <<< "$BRIDGE"
  SOURCE="native/macos/$NAME.swift"
  OUTPUT="build/$DIR/lib$NAME.dylib"

  if [ -f "$OUTPUT" ] && [ "$OUTPUT" -nt "$SOURCE" ] && [ "$OUTPUT" -nt "$0" ]; then
    echo "$OUTPUT is up to date"
    continue
  fi

  for ARCH in arm64 x86_64; do
    xcrun swiftc -O -emit-library \
      -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
      -framework "$FRAMEWORK" \
      -Xlinker -install_name -Xlinker "@rpath/lib$NAME.dylib" \
      -o "$WORK_DIR/lib$NAME-$ARCH.dylib" \
      "$SOURCE"
  done

  mkdir -p "build/$DIR"
  lipo -create -output "$OUTPUT" "$WORK_DIR"/lib"$NAME"-*.dylib
  echo "Built $OUTPUT ($(lipo -archs "$OUTPUT"))"
done
