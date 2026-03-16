#!/bin/bash
# Downloads Alpine minirootfs for bundling into the Electron app as a WSL2 distro.
#
# The rootfs is imported into WSL2 via `wsl --import` on first run.
# Packages (containerd, nerdctl, etc.) are installed on first boot via
# a provision script — no pre-baking needed.
#
# Usage: ./scripts/download-wsl-rootfs.sh [x86_64|aarch64]
#
# Output:
#   build/wsl2/alpine-rootfs.tar.gz    - Alpine minirootfs tarball
#
# electron-builder picks this up via the extraResources config in package.json.

set -euo pipefail

ALPINE_VERSION="3.23.3"
ARCH="${1:-x86_64}"

# Normalize architecture names
case "$ARCH" in
  x86_64|amd64)   ARCH="x86_64" ;;
  aarch64|arm64)   ARCH="aarch64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

OUTPUT_DIR="build/wsl2"

# Clean previous download
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ── Download Alpine minirootfs ─────────────────────────────────────────────────

ALPINE_ROOTFS_NAME="alpine-minirootfs-${ALPINE_VERSION}-${ARCH}.tar.gz"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/${ARCH}/${ALPINE_ROOTFS_NAME}"
ROOTFS_OUTPUT="${OUTPUT_DIR}/alpine-rootfs.tar.gz"

echo "Downloading Alpine ${ALPINE_VERSION} minirootfs for ${ARCH}..."
curl -fSL "$ALPINE_URL" -o "$ROOTFS_OUTPUT"

# Verify the download
if [ ! -f "$ROOTFS_OUTPUT" ]; then
  echo "ERROR: Failed to download Alpine minirootfs"
  exit 1
fi

echo "  alpine-rootfs: $(du -h "$ROOTFS_OUTPUT" | cut -f1)"
echo ""
echo "Total bundle size: $(du -sh "$OUTPUT_DIR" | cut -f1)"
