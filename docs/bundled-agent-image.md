# The bundled agent image

The macOS app ships the agent image it runs, so a new install starts its first
agent without downloading anything: the VM image, its Linux packages
(`scripts/download-lima.sh`) and the agent image are all in the bundle.

## Build

`npm run dist:mac` runs `download:agent-image`
(`scripts/fetch-agent-image.ts`). The script downloads
`ghcr.io/skillfulagents/superagent-agent-container-base:<package.json version>`,
the image `getDefaultAgentImage()` names, for the build machine's
architecture. It uses plain HTTPS, with no Docker and no VM, because CI's macOS
runners have neither. Every blob is checked against its digest and size.

It then recompresses the gzip layers as zstd, level 19
(`scripts/lib/zstd-layers.ts`), which makes the archive about a quarter
smaller: 0.6.0's went from 733 to 543 MiB. That keeps the macOS update ZIP
under 1 GiB, the most Gamut 0.5.47 and older (Electron 41) can install. Their
updater (Squirrel.Mac) holds the whole download in one buffer, which macOS grows
to 2 GiB past 1 GiB, and Chromium's allocator refuses a 2 GiB allocation, so
the app crashes. Each layer's uncompressed tar is checked against the image
config's diff ID. The config, and so the image ID, is the registry's. zstd
needs Node 22.15 or later. Without it a release fails, and other builds warn
and keep gzip.

It writes two files to `build/agent-image/`, which electron-builder copies to
`Resources/agent-image/`:

- `agent-image.tar`: an OCI image layout plus Docker's `manifest.json`, the
  format `docker save` writes. The tar has no owner and no timestamps, and the
  base layers come first, so the same image always makes the same bytes. That
  holds for zstd too: each layer is compressed on one thread, and fed to it
  one chunk at a time so that how the data happens to be chunked doesn't change
  the output (`compressZstd`). Its bytes then depend only on the level and
  Node's libzstd.
- `agent-image.json`: the image reference, architecture, the registry's
  manifest digest and the archive size (`bundled-agent-image-schema.ts`).

If the tag isn't published, the script warns and bundles nothing; the app then
pulls the image as it always did. A release sets `AGENT_IMAGE_REQUIRED=true`, so
there the missing tag is an error. `release.yml`'s `build-mac` job therefore
waits for `build-agent-container`, about 35 s when the layers are cached from
main, and so does its `build-mas` job. `npm run dist:mas` defaults the flag to
`true`, because a Store package is built to upload; a PR's on-demand Store
build, which is never uploaded, sets it to `false`. In CI the download itself
takes about 8 s. Signing and notarizing the
bigger app took 13 and 16 min in two PR builds, instead of about 6, so the
macOS job runs about 21–24 min instead of 13.

Windows ships no archive: its installer carries both x64 and arm64, so the
images would add about 1.5 GiB.

## Runtime

`pullImage` (`client-factory.ts`) runs for every image create: startup's
`ensureImageReady()`, a session start's `ensureImageExists()`, and the rebuild
of a damaged image. When the archive in the bundle names the requested image
for this machine (`findBundledAgentImage`), `pullImage` streams the archive
into the runner's `load` instead of pulling. For Lima that is `nerdctl load`
over `limactl shell`, since the VM doesn't mount the app bundle. Then:

- it checks that the image exists under its name;
- it runs the same integrity check as after a pull;
- the old-image cleanup follows;
- any failure along the way falls back to the pull. The image is removed
  first: a `nerdctl load` that fails while unpacking leaves the image's name
  behind (seen with a garbled archive), and if the pull fails too, a caller's
  "did the image appear?" re-check would take that name for a working image.
  containerd checks every blob's digest as it ingests it, so a damaged archive
  fails the load; it can't load as a wrong image.

containerd has read zstd layers since 1.5. With 0.6.0's baked VM image
(containerd 2.2.0, nerdctl 2.1.6), the zstd archive loaded in 11 s against
17 s for the gzip one. Both gave the same image ID and the same 1.98 GB
unpacked, and the container ran.

A custom image in settings, another architecture, or a truncated archive
(wrong size) is never loaded. Only the built-in Lima runtime loads the archive
(`loadsImageArchive` in the runner registry). Docker, Podman and Apple's
runtime pull as before.

## Costs (0.5.49, arm64, measured)

| | Pulled (before) | Bundled |
| --- | --- | --- |
| DMG / ZIP | 363 / 353 MiB | 1090 / 1079 MiB; ~1165 MiB with the VM image's installed packages (#1600). The CI size budget is 1300 |
| Agent image | 730 MiB from ghcr.io, after install | in the DMG and the ZIP |
| First image create, same VM, empty store | 32.9 s (a fast connection) | 16.2 s, no network |
| VM disk | 730 MiB content + 1.8 GiB unpacked | the same |
| Host disk | — | +730 MiB in the app bundle, and +730 MiB in the updater's cached `update.zip` once it has updated the app |

Loading from a copy in the home mount instead of stdin took 16.7 s, so stdin
stays: it needs no copy and works in the Store build, whose VM mounts only the
data folder.

### The updater's two copies of the ZIP

electron-updater keeps two copies of each update ZIP, in
`~/Library/Caches/superagent-updater`:

- `pending/<file>.zip`, the download. It is read only to install it, and
  electron-updater empties `pending/` when the next download starts.
- `update.zip`, the base the next update's differential download compares
  against.

Bundled, each copy is 1.1 GiB, not 353 MiB. Once the update is installed, the
pending copy is dead weight, so on macOS the app removes it at launch
(`src/main/update-download-cache.ts`), before the updater takes any check or
download. It removes the copy when the running app is that version or newer,
keeps `update.zip`, and keeps a downloaded update that isn't installed yet.
That frees 1.1 GiB, or 353 MiB on a build without the bundle. The table's host
disk row is what remains.

### Updates

Every release tags a new agent image. Before, an update downloaded the app's
differential ZIP and then pulled the image's new layers. The new layers between
stable releases were 745, 394, 370 and 703 MiB (0.5.44 → 0.5.48), and under
1 MiB from 0.5.48 through 0.5.49's release candidates to 0.5.49. Now the image travels in the ZIP. electron-updater's
blockmap differential reuses unchanged layers: the archive's bytes are
deterministic, and the zip's deflate stream is per file.

| Update (differential ZIP, electron-updater's own plan) | Download, plus the 1.1 MiB blockmap |
| --- | --- |
| Same image, app code changed | the app's own delta + 0.1 MiB; the blockmap is 0.7 MiB larger than before |
| Image layers unchanged, config changed (0.5.49-rc.3 → 0.5.49) | 2.4 MiB |
| 370.5 MiB of new layers (0.5.46 → 0.5.47) | 371.3 MiB |
| The first update that adds the image | 728 MiB |

So an update costs what it did, moved from the pull into the update. There are
two exceptions:

- The first update to a version with the bundle downloads the whole image once,
  even where the image changed little. So does the first update with zstd
  layers (about 543 MiB), and the first one built on a Node with a different
  libzstd.
- An install that has never auto-updated has no cached `update.zip`.
  electron-updater then downloads the full ZIP, now 1.1 GiB instead of 353 MiB.
  Before, it downloaded the 353 MiB ZIP and pulled the new layers.

Measured with `archive('zip')` and `buildBlockMap` from app-builder-lib, on
ZIPs that differ only in the archive, and `computeOperations` from
electron-updater.
