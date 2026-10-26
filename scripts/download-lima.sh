#!/bin/bash
# Downloads Lima (limactl) binary and guest agent, and adds the VM image and
# first-boot packages, for bundling into the Electron app.
#
# The VM image is Alpine's cloud image with sudo and the packages a new VM
# needs (containerd, nerdctl, etc.; src/shared/lib/container/lima-packages.json)
# installed; the packages also ship as a local apk repository, to repair an
# install. build-lima-image.sh builds both, which needs Docker. CI builds them
# in a Linux job and points LIMA_IMAGE_DIR at its output, since its macOS
# runners have no Docker.
#
# Usage: [LIMA_IMAGE_DIR=dir] ./scripts/download-lima.sh [arm64|x86_64]
#
# Output:
#   build/lima/bin/limactl                              - Lima CLI binary
#   build/lima/bin/lima-nerdctl                         - nerdctl wrapper (scripts/lima-nerdctl)
#   build/lima/share/lima/lima-guestagent.Linux-*.gz     - Guest agent for the VM
#   build/lima/alpine.qcow2                             - Alpine cloud image, packages installed
#   build/lima/packages/                                - First-boot packages (local apk repository)
#
# electron-builder picks these up via the extraResources config in package.json.

set -euo pipefail

LIMA_VERSION="2.1.3"
ARCH="${1:-$(uname -m)}"

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

# The nerdctl wrapper ships next to limactl, which it finds through its own path.
install -m 755 "$(dirname "$0")/lima-nerdctl" "${BIN_DIR}/lima-nerdctl"
echo "  lima-nerdctl: installed"

# ── 2. VM image and first-boot packages ───────────────────────────────────────

echo ""
if [ -n "${LIMA_IMAGE_DIR:-}" ]; then
  echo "Using the VM image and packages from ${LIMA_IMAGE_DIR}..."
  if [ ! -f "${LIMA_IMAGE_DIR}/alpine.qcow2" ] || [ ! -f "${LIMA_IMAGE_DIR}/packages/packages.txt" ]; then
    echo "ERROR: ${LIMA_IMAGE_DIR} has no alpine.qcow2 or packages/ (scripts/build-lima-image.sh makes them)"
    exit 1
  fi
  cp "${LIMA_IMAGE_DIR}/alpine.qcow2" "${OUTPUT_DIR}/alpine.qcow2"
  cp -R "${LIMA_IMAGE_DIR}/packages" "${OUTPUT_DIR}/packages"
  echo "  alpine-image: $(du -h "${OUTPUT_DIR}/alpine.qcow2" | cut -f1)"
else
  bash "$(dirname "$0")/build-lima-image.sh" "$GUEST_ARCH" "$OUTPUT_DIR"
fi

echo ""
echo "Total bundle size: $(du -sh "$OUTPUT_DIR" | cut -f1)"
