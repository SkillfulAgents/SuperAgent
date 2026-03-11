#!/bin/bash
# Downloads Lima (limactl) binary, guest agent, and a pre-baked Alpine VM image
# with containerd + nerdctl, for bundling into the Electron app.
#
# The VM image is downloaded from a GitHub Release (pre-baked by bake-lima-image.sh).
#
# Usage: ./scripts/download-lima.sh [arm64|x86_64]
#
# Output:
#   build/lima/bin/limactl                              - Lima CLI binary
#   build/lima/share/lima/lima-guestagent.Linux-*.gz     - Guest agent for the VM
#   build/lima/vm-image.qcow2                           - Alpine image with containerd+nerdctl
#
# electron-builder picks these up via the extraResources config in package.json.

set -euo pipefail

LIMA_VERSION="2.0.3"
ALPINE_VERSION="3.23.3"
ARCH="${1:-$(uname -m)}"
REPO="SkillfulAgents/SuperAgent"
RELEASE_TAG="lima-vm-images"

# Normalize to match Lima release naming (arm64, x86_64)
case "$ARCH" in
  arm64|aarch64) LIMA_ARCH="arm64"; GUEST_ARCH="aarch64" ;;
  x86_64|amd64)  LIMA_ARCH="x86_64"; GUEST_ARCH="x86_64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

OUTPUT_DIR="build/lima"
BIN_DIR="${OUTPUT_DIR}/bin"
SHARE_DIR="${OUTPUT_DIR}/share/lima"
LIMACTL="${BIN_DIR}/limactl"

# Clean previous download
rm -rf "$OUTPUT_DIR"
mkdir -p "$BIN_DIR" "$SHARE_DIR"

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

# ── 1. Download Lima release (limactl + guest agent) ──────────────────────────

LIMA_URL="https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-${LIMA_ARCH}.tar.gz"
LIMA_SHA_URL="https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/SHA256SUMS"
echo "Downloading Lima v${LIMA_VERSION} for Darwin-${LIMA_ARCH}..."
curl -fSL "$LIMA_URL" -o "$TMPFILE"

# Verify SHA256 checksum
echo "Verifying Lima checksum..."
LIMA_SHA_FILE=$(mktemp)
curl -fSL "$LIMA_SHA_URL" -o "$LIMA_SHA_FILE"
EXPECTED_SHA=$(grep "lima-${LIMA_VERSION}-Darwin-${LIMA_ARCH}.tar.gz" "$LIMA_SHA_FILE" | awk '{print $1}')
ACTUAL_SHA=$(shasum -a 256 "$TMPFILE" | awk '{print $1}')
rm -f "$LIMA_SHA_FILE"
if [ -z "$EXPECTED_SHA" ]; then
  echo "WARNING: Could not find expected checksum for Lima tarball"
elif [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "ERROR: Lima checksum mismatch!"
  echo "  Expected: $EXPECTED_SHA"
  echo "  Actual:   $ACTUAL_SHA"
  exit 1
else
  echo "  Checksum verified: $ACTUAL_SHA"
fi

tar -xzf "$TMPFILE" -C "$OUTPUT_DIR" --strip-components=0 \
  bin/limactl \
  "share/lima/lima-guestagent.Linux-${GUEST_ARCH}.gz"

if [ -x "$LIMACTL" ]; then
  echo "  limactl: $(du -h "$LIMACTL" | cut -f1)"
  "$LIMACTL" --version
else
  echo "ERROR: limactl binary not found or not executable"
  exit 1
fi

GUEST_AGENT="${SHARE_DIR}/lima-guestagent.Linux-${GUEST_ARCH}.gz"
if [ -f "$GUEST_AGENT" ]; then
  echo "  guest-agent: $(du -h "$GUEST_AGENT" | cut -f1)"
else
  echo "ERROR: guest agent not found at $GUEST_AGENT"
  exit 1
fi

# ── 2. Download pre-baked VM image from GitHub Release ────────────────────────

ASSET_NAME="vm-image-alpine-${ALPINE_VERSION}-${GUEST_ARCH}.qcow2"
VM_IMAGE="${OUTPUT_DIR}/vm-image.qcow2"
IMAGE_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET_NAME}"

echo ""
echo "Downloading pre-baked VM image (${ASSET_NAME})..."
if ! curl -fSL "$IMAGE_URL" -o "$VM_IMAGE"; then
  echo ""
  echo "ERROR: Failed to download pre-baked VM image."
  echo "  URL: $IMAGE_URL"
  echo ""
  echo "You need to bake and upload the image first:"
  echo "  ./scripts/bake-lima-image.sh"
  exit 1
fi

echo "  vm-image: $(du -h "$VM_IMAGE" | cut -f1)"

echo ""
echo "Total bundle size: $(du -sh "$OUTPUT_DIR" | cut -f1)"
