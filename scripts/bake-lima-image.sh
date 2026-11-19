#!/bin/sh
# Installs packages into an Alpine cloud image without booting it, so a new
# Lima VM's first boot installs nothing and downloads nothing.
#
# Runs as root on Linux, in a privileged container of the guest's
# architecture (build-lima-image.sh starts one): it loop-mounts the image's
# root partition and runs the image's own apk in a chroot, from a local apk
# repository only. cloud-init's state is untouched, so the VM's first boot is
# still a first boot.
#
# Usage: bake-lima-image.sh <in.qcow2> <apk-repo-dir> <out.qcow2> <package...>
#   <apk-repo-dir> holds main/ and community/ (scripts/fetch-lima-packages.ts).
#
# Needs: qemu-img, sfdisk, e2fsck, resize2fs, losetup, mountpoint, fstrim.

set -eu

IN="$1"
REPO="$2"
OUT="$3"
shift 3
[ "$#" -gt 0 ] || { echo "Usage: bake-lima-image.sh <in.qcow2> <apk-repo-dir> <out.qcow2> <package...>" >&2; exit 2; }

# Room for the packages. The VM's first boot grows the partition to the whole disk anyway.
GROW_BY=1G
WORK=$(mktemp -d)
RAW="$WORK/disk.raw"
ROOT="$WORK/root"
LOOP=""

cleanup() {
  set +e
  for m in "$ROOT/tmp/packages" "$ROOT/dev" "$ROOT/proc" "$ROOT"; do
    mountpoint -q "$m" && umount "$m"
  done
  [ -n "$LOOP" ] && losetup -d "$LOOP"
  rm -rf "$WORK"
}
trap cleanup EXIT

qemu-img convert -O raw "$IN" "$RAW"
qemu-img resize -f raw "$RAW" "+$GROW_BY"
# Move GPT's backup header to the new end, then give the root partition the new space.
sfdisk --relocate gpt-bak-std "$RAW"
root_partition() { sfdisk -d "$RAW" | grep 'name="/"'; }
ROOT_PART=$(root_partition | cut -d' ' -f1)
[ -n "$ROOT_PART" ] || { echo "No partition named / in $IN" >&2; exit 1; }
echo ', +' | sfdisk --no-reread --no-tell-kernel -N "${ROOT_PART##*[!0-9]}" "$RAW"

# By offset: a container has no udev to create partition devices.
START=$(root_partition | sed -n 's/.*start= *\([0-9]*\).*/\1/p')
SIZE=$(root_partition | sed -n 's/.*size= *\([0-9]*\).*/\1/p')
LOOP=$(losetup --find --show --offset $((START * 512)) --sizelimit $((SIZE * 512)) "$RAW")
e2fsck -fy "$LOOP" || [ $? -le 1 ]
resize2fs "$LOOP"

mkdir -p "$ROOT"
mount "$LOOP" "$ROOT"
mount -t proc proc "$ROOT/proc"
mount --bind /dev "$ROOT/dev"
# apk misreads a repository path with a space, so give it a plain one.
mkdir -p "$ROOT/tmp/packages"
mount --bind -o ro "$REPO" "$ROOT/tmp/packages"

# The image's own apk and keys: they check Alpine's index signature, and each
# package against the index.
chroot "$ROOT" /sbin/apk add --no-network --no-cache --repositories-file /dev/null \
  --repository /tmp/packages/main --repository /tmp/packages/community "$@"
for spec in "$@"; do
  name="${spec%%[~<>=]*}"
  chroot "$ROOT" /sbin/apk info -e "$name" >/dev/null || { echo "$name is not installed" >&2; exit 1; }
done

# Lima's first boot deletes the image's own user and reboots once, so that
# cloud-init sets up the VM's user without it (00-alpine-user-group.sh, which
# does nothing when the user is gone). Deleting it here saves that reboot.
if chroot "$ROOT" id -u alpine >/dev/null 2>&1; then
  chroot "$ROOT" userdel alpine
  rmdir "$ROOT/home/alpine"
fi
# Lima's boot gives its #!/bin/bash scripts a /bin/bash that runs ash
# (01-alpine-ash-as-bash.sh; this is the same file). One of them runs before
# that (00-reboot-if-required.sh), which only works after the reboot.
if [ ! -e "$ROOT/bin/bash" ]; then
  printf '#!/bin/sh\nexec /bin/ash "$@"\n' > "$ROOT/bin/bash"
  chmod +x "$ROOT/bin/bash"
fi

umount "$ROOT/tmp/packages"
rmdir "$ROOT/tmp/packages"
umount "$ROOT/dev" "$ROOT/proc"
rm -rf "$ROOT/var/cache/apk/"*
# Unused blocks read back as zeros, so the compressed image holds only files.
fstrim "$ROOT"
umount "$ROOT"
losetup -d "$LOOP"
LOOP=""

qemu-img convert -c -O qcow2 "$RAW" "$OUT"
echo "  installed: $*"
