# macOS Spotlight

The desktop app puts its agents, dashboards and recent sessions into macOS
Spotlight. They show up in Spotlight's in-app scope (verified on macOS 27: type
the app's name, then the query; the scope lists every entry before anything is
typed) and in ordinary Spotlight results. A click opens the thing in the app.

Both Superagents are indexed side by side: this computer's and the cloud
workspace's, each entry labelled with where it lives (`Session · Finance ·
Cloud`). While there is a workspace, two more entries, "This computer" and
"Cloud workspace", switch the app between them.

macOS only. No App Intents, no app extension: plain Core Spotlight items.

## Pieces

| Where | What |
| --- | --- |
| `native/macos/SpotlightBridge.swift` | One C function, `spotlight_apply(json)`: domain deletes, id deletes, upserts, in that order. |
| `scripts/build-spotlight-bridge.sh` | Builds it into `build/spotlight-bridge/libSpotlightBridge.dylib` (arm64 + x86_64, macOS 12+). Part of `dist:mac`; shipped as an extra resource. |
| `src/main/spotlight/spotlight-bridge.ts` | Loads the dylib with koffi and calls it on a worker thread, one call at a time. |
| `src/main/spotlight/spotlight-items.ts` | Item ids, labels, and the diff. |
| `src/main/spotlight/spotlight-sync.ts` | What to index, when, and what to do when a side is down or gone. |
| `src/main/spotlight/spotlight-activation.ts` | What a click does. |
| `src/main/spotlight/index.ts` | Wiring for `main/index.ts`. |

## Why it is shaped this way

**The dylib runs inside the main process.** Spotlight files every item under the
bundle identifier of the process that indexed it, and that is what scopes results
to the app. A helper binary would index them as someone else. koffi (not a
node-gyp addon) because the bridge is Swift and needs no compile step at
`npm install`. It is imported lazily, on macOS only: koffi loads its native
addon on import and throws when the platform has none (a Windows arm64 package
built on an x64 runner, for one).

**The app writes; macOS never asks.** The index persists across launches and
changes only when written. The first pass in a process replaces each domain whole
(what the previous run left is unknown); later passes send only differences.
The first pass waits 20 s after launch, out of the window's boot; then every 5
minutes, a few seconds after a session event on this computer's notification
stream (`os_notification`), and after a target switch. An agent's sessions are
re-listed only when its `lastActivityAt`/`sessionCount` moves, or hourly
(renames don't move activity). At most 50 sessions per agent, newest first, via
the summary path (`sort_by` + `limit`), which reads no transcripts.

**The cloud side is polled only while the app is driving it.** Otherwise it is
read once after launch (retried until it answers) and once after each switch, so
a desktop that is not using the workspace is never what keeps it awake.

**Down is not gone.** A Superagent that does not answer keeps its entries. One
that no longer exists (the workspace was disconnected) or refuses us (401/403:
the token was rejected, the user left the org) loses them: its domain is
deleted. Items never expire (Spotlight's default is a month).

**Domains:** `local`, `cloud`, `workspace`. One delete clears a side.

**Item ids** are `v1/<kind>/<target>/<slug>[/<id>]`, each part URI-encoded.
macOS hands the id back on a click. An id this version did not write just shows
the window.

**The cloud base URL carries the per-boot proxy key** (`/cloud/<key>/…`), so
nothing here logs a URL.

## A click

macOS continues the app with activity type `com.apple.corespotlightitem`
(declared in `NSUserActivityTypes`), and the item id sits in
`userInfo.kCSSearchableItemActivityIdentifier`. Both `will-continue-activity`
and `continue-activity` must be claimed. A click that launches the app arrives
before the app is up and is held until `startSpotlight`.

- **Same side as the app:** an agent opens its page, a session opens the
  session, a dashboard opens its popout. Delivery goes through the menu-command
  queue (`sendMenuCommand` in `app-menu.ts`), so a closed or loading window
  still gets it.
- **The other side:** main sends `switch-target`. The renderer runs it through
  `useTargetSwitch().switchTo`, the same path as pressing Local/Cloud, checks and
  banners included. A request replayed on a fresh window's mount waits for the
  platform status to load first (`ready`), because before that Cloud reads as
  "not connected". Once the reloaded main window flushes its menu commands, main
  opens the result on the side it came from. A switch the renderer does not make
  (workspace asleep, not connected, one already under way) is reported back
  (`target-switch-declined`) and the result dropped, so a later switch of the
  user's own does not open it; 60 s bounds anything that reports nothing.
- The Spotlight-driven switch runs on the menu-command handler's own
  `useTargetSwitch`, so the sidebar control does not show it as in flight. That
  was already true of the sidebar's two instances (the control and the user
  menu).

## Developing

- `npm run build:spotlight-bridge` once; without it, dev logs one line and skips
  indexing.
- A dev build is `Electron.app`, so its entries are under **Electron** in
  Spotlight, not Gamut. Every dev checkout shares that bundle id: two running at
  once each replace the other's entries on their first pass.
- **Spotlight hides the results of an ad-hoc-signed app.** The stock
  `node_modules/electron/dist/Electron.app` is ad-hoc signed, so its writes
  succeed and land in the index, and Spotlight shows none of them. Sign it with
  a team identity once per install (packaged builds are Developer ID signed and
  unaffected):

  ```sh
  codesign --force --deep --sign "Apple Development: <you> (<id>)" node_modules/electron/dist/Electron.app
  ```

- `mdfind` cannot see Core Spotlight items. Spotlight itself shows what is
  visible; a `CSSearchQuery` run from inside the same app shows what is stored.
- Without a platform stack, a cloud side can be faked in a dev build: a
  `cloudWorkspace` record in the dev data dir's `settings.json` pointing at a
  loopback `deploymentUrl` (dev builds allow loopback, see
  `deploymentHostPolicy`). Point it at the dev app's own API and the same agents
  come back labelled Cloud. Switching *to* local needs no platform, so starting
  with `"apiTarget": "cloud"` lets a Local result exercise the whole switch.
