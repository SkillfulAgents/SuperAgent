#!/bin/bash
# Builds limactl from source for the Mac App Store build, which can't ship
# Lima's release binary: it references a private Virtualization.framework class,
# _VZGDBDebugStubConfiguration, and App Review rejects the app for it.
#
# The class comes from github.com/Code-Hex/vz, the library Lima's vz driver is
# built on. vz's virtualization_debug.m wraps the framework's private GDB debug
# stub. The Go half of that API (debug.go) builds only with the `debug` tag, but
# the .m file has no build constraint, so cgo compiles it into every binary and
# the class is referenced though nothing calls it. This build deletes that file
# from vz and otherwise builds limactl as the release was: the same commit, Go
# version and flags, all read from the release binary's build info.
#
# Upstream: https://github.com/lima-vm/lima/issues/5705. Once a Lima release's
# limactl no longer references the class, the Store build can ship the release
# binary again: delete this script, LIMACTL_FROM_SOURCE in download-lima.sh, the
# download:lima:mas script in package.json (and its test in
# mas-build-config.test.ts) and the Go setup in build-mas.yml. Keep build-mas.yml's
# check of the packaged limactl, which the release binary will then pass.
#
# Usage: ./scripts/build-limactl.sh <limactl>
#   <limactl>  Lima's release limactl, checksum-verified by download-lima.sh,
#              which the source build replaces in place.
#
# Needs git, Xcode's command line tools and Go 1.21 or later, which fetches the
# release's own Go version to build with.

set -euo pipefail

LIMACTL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
LIMA_REPO="https://github.com/lima-vm/lima"
VZ_MODULE="github.com/Code-Hex/vz/v3"

# A private class's symbol is its name, which starts with an underscore, after
# this prefix: _OBJC_CLASS_$__VZGDBDebugStubConfiguration.
PRIVATE_CLASS_PREFIX='_OBJC_CLASS_$__'

# ── 1. What the release was built from ────────────────────────────────────────

INFO=$(go version -m "$LIMACTL")
setting() { printf '%s\n' "$INFO" | awk -F'\t' -v key="$1" '$2 == "build" && index($3, key "=") == 1 { print substr($3, length(key) + 2) }'; }
unquote() { local value="$1"; value="${value#\"}"; printf '%s' "${value%\"}"; }

GO_VERSION=$(printf '%s\n' "$INFO" | head -1 | awk '{ print $2 }')
REVISION=$(setting vcs.revision)
LDFLAGS=$(unquote "$(setting -ldflags)")
TAGS=$(setting -tags)
TARGET_ARCH=$(setting GOARCH)

if [ -z "$REVISION" ] || [ "$(setting vcs.modified)" != false ]; then
  echo "ERROR: $LIMACTL's build info names no clean Lima commit to build"
  exit 1
fi
echo "Building limactl from source: Lima ${REVISION:0:12}, ${GO_VERSION}, -ldflags='${LDFLAGS}'${TAGS:+, -tags=$TAGS}"

WORK=$(mktemp -d)
# Go's module cache, and so the copy of vz below, is read-only.
trap 'chmod -R u+w "$WORK"; rm -rf "$WORK"' EXIT

# ── 2. Lima at that commit, with vz minus the debug stub ──────────────────────

git init --quiet "$WORK/lima"
git -C "$WORK/lima" fetch --quiet --depth 1 "$LIMA_REPO" "$REVISION"
git -C "$WORK/lima" checkout --quiet FETCH_HEAD

cd "$WORK/lima"
export GOTOOLCHAIN="$GO_VERSION" GOFLAGS='' CGO_ENABLED=1 GOOS=darwin GOARCH="$TARGET_ARCH"
go mod download "$VZ_MODULE"
cp -R "$(go list -m -f '{{.Dir}}' "$VZ_MODULE")" "$WORK/vz"
chmod -R u+w "$WORK/vz"
rm "$WORK/vz/virtualization_debug.m" "$WORK/vz/virtualization_debug.h"
go mod edit -replace "$VZ_MODULE=$WORK/vz"

# ── 3. Build, and check the result ────────────────────────────────────────────

go build -ldflags="$LDFLAGS" ${TAGS:+-tags="$TAGS"} -o "$WORK/limactl" ./cmd/limactl

if nm -u "$WORK/limactl" | grep -F "$PRIVATE_CLASS_PREFIX"; then
  echo "ERROR: the source-built limactl still references the private classes above"
  exit 1
fi

mv "$WORK/limactl" "$LIMACTL"
echo "  limactl: built from source, no private Virtualization.framework classes"
