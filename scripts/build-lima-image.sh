#!/bin/bash
# Builds the VM image the app's built-in Lima runtime boots: Alpine's cloud
# image with sudo and the first-boot packages (containerd, nerdctl, etc.;
# src/shared/lib/container/lima-packages.json) installed, and the packages
# themselves as a local apk repository, which the app keeps shipping to
# repair an install.
#
# The image is built without booting it (bake-lima-image.sh, in a privileged
# Linux container of the guest's architecture), so it needs Docker, not
# virtualization: Docker Desktop on a Mac, or CI's Linux runners. CI's macOS
# runners have neither, so CI builds it in a Linux job and hands it to the
# macOS build (download-lima.sh's LIMA_IMAGE_DIR).
#
# Usage: ./scripts/build-lima-image.sh [arm64|x86_64] [out-dir]
#
# Output:
#   <out-dir>/alpine.qcow2   - Alpine cloud image with the packages installed
#   <out-dir>/packages/      - The same packages (local apk repository)
#
# Without a working Docker outside CI it ships the stock cloud image instead,
# whose first boot downloads sudo from Alpine's CDN and installs the packages
# from the local repository.

set -euo pipefail

ALPINE_VERSION="3.23.3"
ARCH="${1:-$(uname -m)}"
OUTPUT_DIR="${2:-build/lima-image}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

case "$ARCH" in
  arm64|aarch64) GUEST_ARCH="aarch64"; DOCKER_PLATFORM="linux/arm64" ;;
  x86_64|amd64)  GUEST_ARCH="x86_64"; DOCKER_PLATFORM="linux/amd64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
STOCK_IMAGE="${OUTPUT_DIR}/alpine-stock.qcow2"
VM_IMAGE="${OUTPUT_DIR}/alpine.qcow2"
rm -rf "$VM_IMAGE" "$STOCK_IMAGE" "${OUTPUT_DIR}/packages"

# ── 1. Download the stock Alpine cloud image ──────────────────────────────────

ALPINE_IMAGE_NAME="nocloud_alpine-${ALPINE_VERSION}-${GUEST_ARCH}-uefi-cloudinit-r0.qcow2"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/cloud/${ALPINE_IMAGE_NAME}"

echo "Downloading Alpine ${ALPINE_VERSION} cloud image..."
curl -fSL "$ALPINE_URL" -o "$STOCK_IMAGE"
echo "  alpine-image (stock): $(du -h "$STOCK_IMAGE" | cut -f1)"

# ── 2. Bundle the packages a new VM installs on first boot ────────────────────

echo ""
echo "Fetching first-boot packages for Alpine v${ALPINE_VERSION%.*} (${GUEST_ARCH})..."
npx --no-install tsx "${SCRIPTS}/fetch-lima-packages.ts" "v${ALPINE_VERSION%.*}" "$GUEST_ARCH" "${OUTPUT_DIR}/packages"

# ── 3. Install them into the image ────────────────────────────────────────────

# sudo first: Lima's own first boot installs it from the CDN when the image lacks it.
PACKAGES=$(node -p "const p = require('${SCRIPTS}/../src/shared/lib/container/lima-packages.json'); [...p.installedByLima, ...p.packages].join(' ')")

echo ""
if docker info >/dev/null 2>&1; then
  echo "Installing ${PACKAGES} into the image (${DOCKER_PLATFORM} container)..."
  docker run --rm --privileged --platform "$DOCKER_PLATFORM" \
    -v "${SCRIPTS}/bake-lima-image.sh:/bake-lima-image.sh:ro" \
    -v "${OUTPUT_DIR}:/out" \
    "alpine:${ALPINE_VERSION}" \
    sh -c "apk add --no-cache qemu-img sfdisk e2fsprogs e2fsprogs-extra util-linux >/dev/null && sh /bake-lima-image.sh /out/alpine-stock.qcow2 /out/packages /out/alpine.qcow2 ${PACKAGES}"
  rm -f "$STOCK_IMAGE"
elif [ -n "${CI:-}" ]; then
  echo "ERROR: Docker is needed to install the packages into the VM image"
  exit 1
else
  echo "WARNING: Docker isn't running, so the app gets the stock Alpine image: its VM's first boot downloads sudo from Alpine's CDN and reboots once."
  mv "$STOCK_IMAGE" "$VM_IMAGE"
fi
echo "  alpine-image: $(du -h "$VM_IMAGE" | cut -f1)"
