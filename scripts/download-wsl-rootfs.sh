#!/bin/bash
# Downloads Alpine minirootfs for bundling into the Electron app as a WSL2 distro.
#
# The rootfs is imported into WSL2 via `wsl --import` on first run.
# Packages (containerd, nerdctl, etc.) are installed on first boot via
# a provision script — no pre-baking needed.
#
# Usage: ./scripts/download-wsl-rootfs.sh
#
# Output:
#   build/wsl2/alpine-rootfs-x86_64.tar.gz   - Alpine minirootfs (x86_64)
#   build/wsl2/alpine-rootfs-aarch64.tar.gz   - Alpine minirootfs (aarch64)
#
# electron-builder picks this up via the extraResources config in package.json.

set -euo pipefail

ALPINE_VERSION="3.23.3"

OUTPUT_DIR="build/wsl2"

# Clean previous download
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ── Download Alpine minirootfs for both architectures ─────────────────────────

for ARCH in x86_64 aarch64; do
  ALPINE_ROOTFS_NAME="alpine-minirootfs-${ALPINE_VERSION}-${ARCH}.tar.gz"
  ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/${ARCH}/${ALPINE_ROOTFS_NAME}"
  ROOTFS_OUTPUT="${OUTPUT_DIR}/alpine-rootfs-${ARCH}.tar.gz"

  echo "Downloading Alpine ${ALPINE_VERSION} minirootfs for ${ARCH}..."
  curl -fSL "$ALPINE_URL" -o "$ROOTFS_OUTPUT"

  if [ ! -f "$ROOTFS_OUTPUT" ]; then
    echo "ERROR: Failed to download Alpine minirootfs for ${ARCH}"
    exit 1
  fi

  echo "  alpine-rootfs-${ARCH}: $(du -h "$ROOTFS_OUTPUT" | cut -f1)"
done

echo ""
echo "Total bundle size: $(du -sh "$OUTPUT_DIR" | cut -f1)"
