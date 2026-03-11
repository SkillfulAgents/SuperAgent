#!/bin/bash
# Bakes an Alpine VM image with containerd + nerdctl pre-installed,
# then uploads it as a GitHub Release asset.
#
# Run this locally (on a real Mac) whenever you bump Alpine or package versions.
# CI will download the pre-baked image from the release instead of baking.
#
# Requirements: limactl, qemu (brew install qemu), gh CLI (brew install gh)
#
# Usage: ./scripts/bake-lima-image.sh

set -euo pipefail

ALPINE_VERSION="3.23.3"
ARCH="${1:-$(uname -m)}"
RELEASE_TAG="lima-vm-images"
REPO="SkillfulAgents/SuperAgent"

case "$ARCH" in
  arm64|aarch64) GUEST_ARCH="aarch64" ;;
  x86_64|amd64)  GUEST_ARCH="x86_64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

ASSET_NAME="vm-image-alpine-${ALPINE_VERSION}-${GUEST_ARCH}.qcow2"

# Resolve limactl — use build/lima/bin/limactl if available (from download-lima.sh)
LIMACTL="limactl"
if [ -x "build/lima/bin/limactl" ]; then
  LIMACTL="$(pwd)/build/lima/bin/limactl"
  echo "Using bundled limactl: $LIMACTL"
elif ! command -v limactl &>/dev/null; then
  echo "ERROR: limactl not found. Run ./scripts/download-lima.sh first, or install limactl."
  exit 1
fi

# Check other prerequisites
for cmd in qemu-img gh; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found"
    exit 1
  fi
done

echo "=== Baking Lima VM image ==="
echo "  Alpine: ${ALPINE_VERSION}"
echo "  Arch:   ${GUEST_ARCH}"
echo ""

# ── 1. Download Alpine cloud image ──────────────────────────────────────────

# Use a short temp path — Lima's Unix socket paths must be < 104 chars
WORK_DIR="/tmp/lima-bake-$$"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION%.*}/releases/cloud/nocloud_alpine-${ALPINE_VERSION}-${GUEST_ARCH}-uefi-cloudinit-r0.qcow2"
RAW_IMAGE="${WORK_DIR}/vm-image-raw.qcow2"

echo "Downloading Alpine ${ALPINE_VERSION} cloud image..."
curl -fSL "$ALPINE_URL" -o "$RAW_IMAGE"
echo "  raw image: $(du -h "$RAW_IMAGE" | cut -f1)"

# ── 2. Boot a temp VM and bake in containerd + nerdctl ──────────────────────

LIMA_HOME="${WORK_DIR}/lima"
mkdir -p "$LIMA_HOME"
TEMP_VM="bake"

BAKE_CONFIG="${WORK_DIR}/bake-config.yaml"
cat > "$BAKE_CONFIG" <<YAML
vmType: vz
mountType: virtiofs
images:
  - location: "file://${RAW_IMAGE}"
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

echo ""
echo "Baking containerd + nerdctl into the VM image..."

cleanup_bake_vm() {
  LIMA_HOME="$LIMA_HOME" "$LIMACTL" stop "$TEMP_VM" --force 2>/dev/null || true
  LIMA_HOME="$LIMA_HOME" "$LIMACTL" delete "$TEMP_VM" --force 2>/dev/null || true
}
trap 'cleanup_bake_vm; rm -rf "$WORK_DIR"' EXIT

LIMA_HOME="$LIMA_HOME" "$LIMACTL" create --name "$TEMP_VM" "$BAKE_CONFIG" --tty=false
LIMA_HOME="$LIMA_HOME" "$LIMACTL" start "$TEMP_VM"

echo "Verifying nerdctl inside VM..."
LIMA_HOME="$LIMA_HOME" "$LIMACTL" shell "$TEMP_VM" -- nerdctl --version

# Clean cloud-init state so it re-runs on next boot.
# Without this, the baked image retains "already ran" markers and Lima
# cannot inject fresh SSH keys when creating a new VM from this image.
echo "Cleaning cloud-init state for re-use..."
LIMA_HOME="$LIMA_HOME" "$LIMACTL" shell "$TEMP_VM" -- sudo cloud-init clean --logs 2>/dev/null \
  || LIMA_HOME="$LIMA_HOME" "$LIMACTL" shell "$TEMP_VM" -- sudo rm -rf /var/lib/cloud

LIMA_HOME="$LIMA_HOME" "$LIMACTL" stop "$TEMP_VM"

# ── 3. Convert diffdisk to compact qcow2 ───────────────────────────────────

DIFF_DISK="${LIMA_HOME}/${TEMP_VM}/diffdisk"
BAKED_IMAGE="${WORK_DIR}/${ASSET_NAME}"

if [ ! -f "$DIFF_DISK" ]; then
  echo "ERROR: diffdisk not found at $DIFF_DISK"
  exit 1
fi

echo "Converting raw disk to qcow2..."
qemu-img convert -f raw -O qcow2 "$DIFF_DISK" "$BAKED_IMAGE"
echo "  baked image: $(du -h "$BAKED_IMAGE" | cut -f1)"

# ── 4. Upload to GitHub Release ─────────────────────────────────────────────

echo ""
echo "Uploading to GitHub Release '${RELEASE_TAG}'..."

# Create the release if it doesn't exist
if ! gh release view "$RELEASE_TAG" --repo "$REPO" &>/dev/null; then
  echo "Creating release '${RELEASE_TAG}'..."
  gh release create "$RELEASE_TAG" \
    --repo "$REPO" \
    --title "Lima VM Images" \
    --notes "Pre-baked Alpine VM images with containerd + nerdctl for the bundled Lima runtime." \
    --latest=false
fi

# Delete existing asset with same name (if re-baking)
gh release delete-asset "$RELEASE_TAG" "$ASSET_NAME" --repo "$REPO" --yes 2>/dev/null || true

# Upload
gh release upload "$RELEASE_TAG" "$BAKED_IMAGE" --repo "$REPO"

echo ""
echo "=== Done ==="
echo "Uploaded: ${ASSET_NAME}"
echo "URL: https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET_NAME}"
