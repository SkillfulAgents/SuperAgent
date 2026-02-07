# Release Process

## Overview

Superagent uses a tag-based release process. Pushing a `v*` tag triggers the release pipeline which builds and publishes all three components:

1. **Electron desktop app** (macOS DMG + ZIP) — attached to a GitHub Release
2. **App container** (`ghcr.io/skilfulagents/superagent`) — pushed to GHCR
3. **Agent container** (`ghcr.io/skilfulagents/superagent-agent-container-base`) — pushed to GHCR

All three artifacts are tagged with the same version, ensuring they stay in sync.

## Prerequisites

### GitHub Secrets

The following repository secrets must be configured for the release workflow:

| Secret | Description |
|--------|-------------|
| `CSC_LINK` | Base64-encoded macOS code signing certificate (.p12) |
| `CSC_KEY_PASSWORD` | Password for the code signing certificate |
| `APPLE_API_KEY` | Base64-encoded App Store Connect API key (.p8) |
| `APPLE_API_KEY_ID` | App Store Connect API Key ID |
| `APPLE_API_ISSUER` | App Store Connect API Issuer ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

These are the same secrets used by the existing `build-mac.yml` CI workflow.

## Creating a Release

### 1. Update the version

```bash
npm version 0.2.0 --no-git-tag-version
```

This updates `package.json` (and `package-lock.json`).

### 2. Commit the version bump

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 0.2.0"
git push origin main
```

### 3. Create and push the tag

```bash
git tag v0.2.0
git push origin v0.2.0
```

### 4. Monitor the release

Go to the repository's **Actions** tab. The `Release` workflow will:

1. Build and push both Docker images with the version tag (e.g. `:0.2.0`)
2. Build, sign, and notarize the macOS Electron app
3. Create a GitHub Release with all Electron artifacts attached

The three build jobs (agent container, app container, macOS app) run in parallel. The GitHub Release is created after all three complete.

## Version Coupling

When a release is built, the app version from `package.json` is injected at build time via `__APP_VERSION__`. This is used to set the default agent container image tag:

- **Production builds**: default agent image is `ghcr.io/skilfulagents/superagent-agent-container-base:0.2.0`
- **Development**: default agent image is `ghcr.io/skilfulagents/superagent-agent-container-base:main`

When users upgrade their Electron app (or pull a new Docker app container), the agent container reference automatically updates to match the new version. Users who have configured a custom agent image (different registry) are unaffected.

## Auto-Update (Electron)

The Electron app uses `electron-updater` with GitHub Releases as the update source.

Users can check for updates from **Settings > General > Software Updates**.

### Update flow

1. User clicks **Check for Updates**
2. If available, click **Download** to download in the background
3. After download, click **Restart & Update** to apply
4. The app restarts with the new version, and the agent container image reference updates automatically

### How it works

- `electron-builder` generates a `latest-mac.yml` metadata file alongside the ZIP artifact
- `electron-updater` checks the GitHub Release for this file to detect new versions
- The ZIP file is used for differential updates on macOS

## CI/CD Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `test.yml` | Push to main, PRs | Tests, linting, typecheck |
| `build-mac.yml` | Push to main | Build macOS app (CI validation) |
| `build-container.yml` | Push to main | Build agent container (`:main` tag) |
| `build-app-container.yml` | Push to main | Build app container (`:main` tag) |
| `release.yml` | `v*` tags | Full release: containers + Electron + GitHub Release |

## Troubleshooting

### Code signing fails

Verify that `CSC_LINK` contains a valid base64-encoded .p12 certificate and `CSC_KEY_PASSWORD` is correct.

### Notarization fails

Verify the Apple API key secrets. The .p8 key must have "Developer ID" permissions in App Store Connect.

### Auto-update not working

- The GitHub Release must contain the `latest-mac.yml` file alongside the ZIP. This is generated automatically by `electron-builder` when the `publish` config is present.
- The app must be code-signed for macOS auto-update to work.
- Auto-update is disabled in development mode.

### Agent container version mismatch

If the agent container for a version hasn't been built yet (e.g. the container build job failed), agents will fail to start. Check the release workflow run and re-trigger if needed.
