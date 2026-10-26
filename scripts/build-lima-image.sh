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
# Usage: [LIMA_IMAGE_CACHE_DIR=dir] ./scripts/build-lima-image.sh [arm64|x86_64] [out-dir] [packages|image]
#
# Output:
#   <out-dir>/alpine.qcow2   - Alpine cloud image with the packages installed
#   <out-dir>/packages/      - The same packages (local apk repository)
#   <out-dir>/inputs.sha256  - What the image was built from (see below)
#
# Two builds of the image differ byte for byte, and the app's auto-update
# downloads every file that changed. So with LIMA_IMAGE_CACHE_DIR, an image
# built from the same inputs (the selected package versions, the stock image,
# these scripts) is reused from there instead, and a new one replaces it.
#
# The last argument runs one half, for CI: `packages` fetches the packages and
# writes inputs.sha256, then `image` reuses or builds the image. In between,
# CI restores its cache by exactly those inputs (.github/workflows/lima-image.yml).
# Without it the script runs both.
#
# Without a working Docker outside CI it ships the stock cloud image instead,
# whose first boot downloads sudo from Alpine's CDN and installs the packages
# from the local repository.

set -euo pipefail

ALPINE_VERSION="3.23.3"
ARCH="${1:-$(uname -m)}"
OUTPUT_DIR="${2:-build/lima-image}"
STEP="${3:-all}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_LIST="${SCRIPTS}/../src/shared/lib/container/lima-packages.json"

case "$ARCH" in
  arm64|aarch64) GUEST_ARCH="aarch64"; DOCKER_PLATFORM="linux/arm64" ;;
  x86_64|amd64)  GUEST_ARCH="x86_64"; DOCKER_PLATFORM="linux/amd64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$STEP" in
  all|packages|image) ;;
  *)
    echo "Unknown step: $STEP (packages, image, or none for both)"
    exit 1
    ;;
esac

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
STOCK_IMAGE="${OUTPUT_DIR}/alpine-stock.qcow2"
VM_IMAGE="${OUTPUT_DIR}/alpine.qcow2"
rm -rf "$VM_IMAGE" "$STOCK_IMAGE"

ALPINE_IMAGE_NAME="nocloud_alpine-${ALPINE_VERSION}-${GUEST_ARCH}-uefi-cloudinit-r0.qcow2"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/cloud/${ALPINE_IMAGE_NAME}"

# ── 1. Bundle the packages a new VM needs ─────────────────────────────────────

if [ "$STEP" != "image" ]; then
  rm -rf "${OUTPUT_DIR}/packages" "${OUTPUT_DIR}/inputs.sha256"
  echo "Fetching first-boot packages for Alpine v${ALPINE_VERSION%.*} (${GUEST_ARCH})..."
  npx --no-install tsx "${SCRIPTS}/fetch-lima-packages.ts" "v${ALPINE_VERSION%.*}" "$GUEST_ARCH" "${OUTPUT_DIR}/packages"

  INPUTS=$( { echo "$ALPINE_IMAGE_NAME"; cat "${OUTPUT_DIR}/packages/packages.txt" "$PACKAGE_LIST" "${SCRIPTS}/bake-lima-image.sh"; } | shasum -a 256 | cut -d' ' -f1)
  echo "$INPUTS" > "${OUTPUT_DIR}/inputs.sha256"
  if [ "$STEP" = "packages" ]; then
    echo "  inputs: ${INPUTS}"
    exit 0
  fi
elif [ ! -f "${OUTPUT_DIR}/inputs.sha256" ] || [ ! -f "${OUTPUT_DIR}/packages/packages.txt" ]; then
  echo "ERROR: ${OUTPUT_DIR} has no packages or inputs.sha256: run the packages step first"
  exit 1
fi
INPUTS=$(cat "${OUTPUT_DIR}/inputs.sha256")

if [ -n "${LIMA_IMAGE_CACHE_DIR:-}" ] && [ -f "${LIMA_IMAGE_CACHE_DIR}/${INPUTS}.qcow2" ]; then
  cp "${LIMA_IMAGE_CACHE_DIR}/${INPUTS}.qcow2" "$VM_IMAGE"
  echo ""
  echo "  alpine-image: $(du -h "$VM_IMAGE" | cut -f1), built earlier from the same inputs (${INPUTS})"
  exit 0
fi

# ── 2. Download the stock Alpine cloud image ──────────────────────────────────

echo ""
echo "Downloading Alpine ${ALPINE_VERSION} cloud image..."
curl -fSL "$ALPINE_URL" -o "$STOCK_IMAGE"
echo "  alpine-image (stock): $(du -h "$STOCK_IMAGE" | cut -f1)"

# ── 3. Install the packages into it ───────────────────────────────────────────

# sudo first: Lima's own first boot installs it from the CDN when the image lacks it.
PACKAGES=$(node -p "const p = require('${PACKAGE_LIST}'); [...p.installedByLima, ...p.packages].join(' ')")

echo ""
if docker info >/dev/null 2>&1; then
  echo "Installing ${PACKAGES} into the image (${DOCKER_PLATFORM} container)..."
  docker run --rm --privileged --platform "$DOCKER_PLATFORM" \
    -v "${SCRIPTS}/bake-lima-image.sh:/bake-lima-image.sh:ro" \
    -v "${OUTPUT_DIR}:/out" \
    "alpine:${ALPINE_VERSION}" \
    sh -c "apk add --no-cache qemu-img sfdisk e2fsprogs e2fsprogs-extra util-linux >/dev/null && sh /bake-lima-image.sh /out/alpine-stock.qcow2 /out/packages /out/alpine.qcow2 ${PACKAGES}"
  rm -f "$STOCK_IMAGE"
  if [ -n "${LIMA_IMAGE_CACHE_DIR:-}" ]; then
    mkdir -p "$LIMA_IMAGE_CACHE_DIR"
    rm -f "${LIMA_IMAGE_CACHE_DIR}/"*.qcow2
    cp "$VM_IMAGE" "${LIMA_IMAGE_CACHE_DIR}/${INPUTS}.qcow2"
  fi
elif [ -n "${CI:-}" ]; then
  echo "ERROR: Docker is needed to install the packages into the VM image"
  exit 1
else
  echo "WARNING: Docker isn't running, so the app gets the stock Alpine image: its VM's first boot downloads sudo from Alpine's CDN and reboots once."
  mv "$STOCK_IMAGE" "$VM_IMAGE"
  rm -f "${OUTPUT_DIR}/inputs.sha256"
fi
echo "  alpine-image: $(du -h "$VM_IMAGE" | cut -f1)"
