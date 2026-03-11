---
description: Bump Alpine/Lima/package versions for the bundled Lima VM image, re-bake, and upload to GitHub Releases
---

# Bump Lima VM Image

Update the Alpine version and/or package versions used in the bundled Lima VM image, then re-bake and upload.

## Context

Superagent bundles a Lima VM with containerd + nerdctl for macOS users who don't have Docker installed. The VM image is pre-baked with packages and hosted as a GitHub Release asset. CI downloads this pre-baked image during builds — it cannot bake in CI because GitHub Actions macOS runners don't support nested virtualization.

## Files involved

- `scripts/bake-lima-image.sh` — Bakes the VM image locally and uploads to GitHub Releases
- `scripts/download-lima.sh` — Downloads Lima binaries + pre-baked image (used by CI and `npm run dist:mac`)
- `src/shared/lib/container/lima-container-client.ts` — Runtime VM configuration

## Steps

1. **Update versions** in `scripts/bake-lima-image.sh` and `scripts/download-lima.sh`:
   - `ALPINE_VERSION` — Alpine Linux version (e.g., `3.23.3`)
   - Package versions in the `apk add` line: `containerd~=X.Y`, `nerdctl~=X.Y`, `buildkit~=X.Y`
   - Both scripts must have matching `ALPINE_VERSION` values

2. **Optionally update Lima version** in `scripts/download-lima.sh`:
   - `LIMA_VERSION` — Lima CLI version (e.g., `2.0.3`)

3. **Bake and upload** the new image:
   ```bash
   npm run bake:lima
   ```
   This boots a local VM (requires a real Mac, not a VM), installs packages, converts the disk, and uploads to the `lima-vm-images` GitHub Release. If an asset with the same name exists, it's replaced.

4. **Verify** the download works:
   ```bash
   npm run download:lima
   ```

5. **Test** with a full build:
   ```bash
   npm run dist:mac
   ```

## npm scripts

| Script | Description |
|--------|-------------|
| `npm run bake:lima` | Bake VM image locally and upload to GitHub Releases |
| `npm run download:lima` | Download Lima binaries + pre-baked VM image |
| `npm run dist:mac` | Full macOS build (runs download:lima automatically) |

## Important notes

- The bake script uses VZ (Virtualization.framework) and must run on a real Mac (macOS 13+), not inside a VM or CI.
- The bake script uses the bundled `limactl` from `build/lima/bin/` if available, or system `limactl`. Run `npm run download:lima` first if you don't have limactl installed.
- The GitHub Release tag is `lima-vm-images` in the `SkillfulAgents/SuperAgent` repo.
- Alpine apk versions use `~=` (compatible release) so minor patches are picked up automatically on bake.
- The `ALPINE_VERSION` in both scripts must match, otherwise CI will try to download a non-existent asset.
