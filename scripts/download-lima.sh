#!/bin/bash
# Downloads Lima (limactl) binary, guest agent, and a pre-configured Alpine VM image
# with containerd + nerdctl baked in, for bundling into the Electron app.
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

# ── 2. Download Alpine cloud image ────────────────────────────────────────────

ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/cloud/nocloud_alpine-${ALPINE_VERSION}-${GUEST_ARCH}-uefi-cloudinit-r0.qcow2"
RAW_IMAGE="${OUTPUT_DIR}/vm-image-raw.qcow2"
echo "Downloading Alpine ${ALPINE_VERSION} cloud image for ${GUEST_ARCH}..."
curl -fSL "$ALPINE_URL" -o "$RAW_IMAGE"
echo "  raw image: $(du -h "$RAW_IMAGE" | cut -f1)"

# ── 3. Boot a temp VM and bake in containerd + nerdctl ─────────────────────────

LIMA_HOME="/tmp/lima-bake-$$"
rm -rf "$LIMA_HOME"
mkdir -p "$LIMA_HOME"
TEMP_VM="bake"

echo ""
echo "Baking containerd + nerdctl into the VM image..."

# Use QEMU for baking — VZ (Virtualization.framework) doesn't work in CI VMs
# (no nested virtualization). The baked disk image works with any VM type at runtime.
# Force cpuType to avoid HVF (also unavailable in CI VMs) — uses TCG software emulation.
BAKE_CONFIG="${LIMA_HOME}/bake-config.yaml"
cat > "$BAKE_CONFIG" <<YAML
vmType: qemu
cpuType:
  aarch64: "cortex-a72"
  x86_64: "qemu64"
images:
  - location: "file://$(cd "$(dirname "$RAW_IMAGE")" && pwd)/$(basename "$RAW_IMAGE")"
    arch: "${GUEST_ARCH}"
disk: 60GiB
containerd:
  system: false
  user: false
provision:
  - mode: system
    script: |
      #!/bin/sh
      apk update
      apk add --no-cache containerd~=2.2 containerd-openrc nerdctl~=2.1 buildkit~=0.25 cni-plugins
      rc-update add containerd default
YAML

cleanup_bake_vm() {
  echo "Cleaning up temp VM..."
  LIMA_HOME="$LIMA_HOME" "$LIMACTL" stop "$TEMP_VM" --force 2>/dev/null || true
  LIMA_HOME="$LIMA_HOME" "$LIMACTL" delete "$TEMP_VM" --force 2>/dev/null || true
  rm -rf "$LIMA_HOME"
  rm -f "$RAW_IMAGE"
}
trap 'cleanup_bake_vm; rm -f "$TMPFILE"' EXIT

# Create and start VM (provisions automatically)
LIMA_HOME="$LIMA_HOME" "$LIMACTL" create --name "$TEMP_VM" "$BAKE_CONFIG" --tty=false
LIMA_HOME="$LIMA_HOME" "$LIMACTL" start "$TEMP_VM"

# Verify nerdctl works inside the VM
echo "Verifying nerdctl inside VM..."
LIMA_HOME="$LIMA_HOME" "$LIMACTL" shell "$TEMP_VM" -- nerdctl --version

# Stop VM cleanly so disk is consistent
LIMA_HOME="$LIMA_HOME" "$LIMACTL" stop "$TEMP_VM"

# Convert the diffdisk (raw, with baked packages) to compact qcow2
DIFF_DISK="${LIMA_HOME}/${TEMP_VM}/diffdisk"
VM_IMAGE="${OUTPUT_DIR}/vm-image.qcow2"

if [ ! -f "$DIFF_DISK" ]; then
  echo "ERROR: diffdisk not found at $DIFF_DISK"
  ls -la "${LIMA_HOME}/${TEMP_VM}/"
  exit 1
fi

if ! command -v qemu-img &> /dev/null; then
  echo "ERROR: qemu-img is required to convert the disk image."
  echo "Install with: brew install qemu"
  exit 1
fi

echo "Converting raw disk to qcow2..."
qemu-img convert -f raw -O qcow2 "$DIFF_DISK" "$VM_IMAGE"

echo "  vm-image (baked): $(du -h "$VM_IMAGE" | cut -f1)"

echo ""
echo "Total bundle size: $(du -sh "$OUTPUT_DIR" | cut -f1)"
