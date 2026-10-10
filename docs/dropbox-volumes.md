# Dropbox volumes

Live filesystem validation is available in
[`e2e/live/dropbox-volumes`](../e2e/live/dropbox-volumes/README.md). It creates a
dedicated `/gamut-test` mount, verifies committed bytes directly with Dropbox,
and leaves per-case reports and checksums for inspection.

The container receives the source's case-sensitivity capability as well as its
cache mode. Dropbox's case-insensitive identity must reach rclone so that a
case-only rename cannot delete its own source. Mounts use rclone's `mount2` FUSE
implementation with kernel entry expiry disabled; directory listings and file
contents remain cached by VFS. This avoids stale inodes after directory renames
and explicit refreshes. Authorized volume uploads use an inactivity deadline
instead of Node's absolute five-minute body deadline, so a large upload can
continue while the cloud service consumes its chunks. Ordinary requests retain
the absolute deadline and stalled uploads still time out.

Stopping an agent uses the bounded drain and workspace recovery in #1340. The
container stops writers and drains for up to 15 seconds. If uploads remain, it
freezes rclone and moves its cache into `recovered-volume-uploads/` in the agent
workspace; the host reports the incomplete drain to Sentry and continues stopping.
The working cache already lives in `.volume-cache/` on that same persistent
workspace, so it survives even if the API is unreachable. Recovery retains the
file bytes and rclone metadata, with no automatic replay onto Dropbox. See
[the shutdown policy](volume-shutdown.md) for timing and recovery details.

In Settings → Volumes → Add volume, or an agent's Volumes → Add Mount → New Volume,
choose a source card. Local folder opens the native folder picker immediately,
then shows the name and access settings. Dropbox shows account selection or
connection first; Next opens the name, folder, and access step. Back keeps the
Dropbox draft, while changing accounts clears the previous folder selection.
Selecting the root mounts the connected account's Dropbox home namespace, including shared
folders mounted there. Team-admin namespace selection is not part of this flow.
Local folders still use the existing OS picker in the local desktop app; Dropbox
creation also works in browsers and cloud workspaces.

The renderer's `volumeSetupRegistry` registers each source's label, logo, config
schema, availability, and `Setup` component. An optional `begin()` runs directly
from source selection (the native picker for local folders); returning `null`
keeps the chooser open. Each source's component owns its steps and validates its
inputs, reusing shared name/access fields and navigation. The generic dialog
validates the completed config with that source's shared Zod schema, then passes
`{ type, config }` through the save hooks without vendor-specific field mapping.
To add another source, implement its setup component and schema, add its driver
and shared config variant, then register its renderer definition. No source
conditions belong in the dialog. Server-side ownership and config validation
remain authoritative.

A definition stores `{ accountId, path }` in the existing validated volume config,
never OAuth credentials. Only the account owner can browse it or create a source
from it. Definitions retain the existing private/public rules: private definitions
belong to their creator; an admin may publish a definition for everyone to attach.
The account owner's authorization is used even when another user attaches a public
volume. Removing or expiring the connection makes its volumes unavailable;
reconnecting that account restores access.

An attachment grants read/write access within the selected folder. It does not
assign the whole connected account to the agent. The agent-token-protected WebDAV
route resolves only that agent's attachments, then calls the same account provider
transport as the API proxy. General API account policies do not apply to this
explicit mount grant. Published mutations (upload/commit, mkdir, delete and move) are written to the
existing API audit log with the actual agent and connected account. Reads and
upload-session staging do not create audit rows, and filesystem traffic never
emits `api_called` analytics. Folder-picker and settings health requests have no
agent identity and do not create agent logs.

`DropboxMountableVolume` implements the existing filesystem interface:

- Paginated directory listings populate a shared, process-local cache of their
  entries and child metadata for 15 seconds. The next folder PROPFIND can reuse
  its parent's metadata instead of fetching it again. Explicit file stats fetch
  fresh sizes/revisions, matching GET/HEAD after external edits. Concurrent requests for the
  same listing share their work. The cache is scoped to account and selected
  root, retaining at most 256 directories and 8,000 entries total. Oversized
  listings are returned in full without being cached. Direct, nonrecursive
  listings keep the first scan focused on folders the agent actually visits;
  Dropbox's recursive listing may return many tiny cursor pages even with a
  large requested limit. The account root is probed with a small listing because
  Dropbox does not support root metadata.
  Continuations can contain deletions and revised entries while a folder is
  changing, even with `include_deleted: false`. Pages are applied in order by
  case-insensitive child name so scans do not fail on tombstones or return stale
  duplicates. See Dropbox's [listing/cursor contract](https://raw.githubusercontent.com/dropbox/dropbox-sdk-python/main/dropbox/base.py).
- The adapter selects the agent's `remote` cache mode: rclone caches directories
  for five minutes and file reads/writes on disk (512 MiB and one-hour cleanup
  targets per mount). External changes appear after cache refresh, rather than
  immediately; a host snapshot can add up to 15 seconds of staleness. Changes
  through the same mount remain visible immediately. Local folders keep the
  one-second directory refresh and write-only file caching.
- Reads pin the metadata's revision, stream content, and support byte ranges.
  The upstream response is established before sending HTTP headers, so download
  rate limits can still return 429 and Retry-After. No temporary download link or
  credential is exposed to the agent.
- Files up to 512 KiB use a single `/files/upload` request, plus two live metadata
  checks (the previous revision and parent). Dropbox allows 150 MiB, but the
  Platform's Composio route caps the entire JSON request at 1,000,000 bytes.
  The 512 KiB limit accounts for base64 expansion and the request envelope.
  Larger uploads stage bounded 512 KiB chunks in sessions, including the first
  chunk in session start. The generic proxy's 4 MiB raw limit is not sufficient
  to keep these encoded requests within the platform limit.
  Reading request bodies and staging uploads run outside the account lock; only
  the short parent check and final commit are serialized. Existing files use a
  revision condition so concurrent edits cause a conflict.
- Namespace mutations from this process are serialized per account across
  overlapping mounts and invalidate every cached root for that account before
  and after the operation, including failures. Mutation preconditions and download revisions
  always use live metadata; folder deletion always checks a fresh listing.
  Each operation verifies that the account exists and is active, including cache
  hits, and shares its authorization/attribution across pages and chunks. Upload
  commits recheck account access after streaming and queueing. Missing parents,
  root mutations, and traversal paths are refused.
- File renames can replace an existing file (including Git lock files and editor
  saves). Under the namespace lock, the destination is moved to a unique sibling
  backup, the source is moved into place, then the backup is deleted using its
  revision. A failed source move attempts to restore the destination; rollback
  never overwrites a concurrent external replacement. A failed rollback or
  cleanup retains the `.gamut-rename-<uuid>` backup for recovery. Occupied folders
  are not replaced. Dropbox has no atomic rename-overwrite: external readers can
  observe the intermediate state, and process/network failures can leave a backup.
- Settings/mount health checks coalesce per account and root, caching success for
  one minute and failure for five seconds (up to 256 entries). They revalidate
  account access on every call; reconnects and mutations invalidate cached health.
  Filesystem operations and volume creation bypass this advisory health cache.
- Folder deletion checks for emptiness first. Dropbox's delete operation is
  recursive and offers no conditional empty-folder delete: an external client
  adding a child between the check and delete can still race it. Likewise, parent
  checks cannot atomically prevent Dropbox from recreating an externally deleted
  parent during a create. These are remote API limits, not POSIX guarantees.
- Non-downloadable cloud documents and symlinks cannot be read as regular files.
  Expired credentials and upstream failures surface as errors. Explicit 429 and
  `too_many_write_operations` rejections use an account-wide cooldown, respecting
  Retry-After (seconds or HTTP date) and exponential backoff even for a zero delay.
  At most four attempts / ten seconds of retry budget are used before returning
  429 + Retry-After to rclone or the picker. Network/5xx mutation failures are not
  replayed because their outcome may be uncertain.

Validation uses a mocked Dropbox provider behind real SQLite/libSQL volume and
WebDAV routes, plus browser tests with deterministic Dropbox account/folder API
responses. Live Dropbox OAuth and an actual account are separate integration
checks; the mock tests do not claim to exercise them.

The 2026-10-08 live run used a dedicated agent mounting only `/gamut-test` through
the real platform/Composio connection. All 36 case groups passed after fixes,
including zero-to-160 MiB files, chunk boundaries, editor/Git renames, concurrent
mutations, external edits, shutdown/restart, and changes between listing pages.
106 independent Dropbox downloads matched their expected SHA-256; the final cold
scan matched all 99 surviving files and sizes. Reports preserve earlier failures
as well as the successful rechecks. Rate limits, revoked accounts and uncertain
transport outcomes remain automated fault tests; this run did not deliberately
throttle or revoke the user's connection. Large transfers remain slow through
the platform proxy's bounded binary request size.

API references: [Dropbox files](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files),
[downloads](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/download),
[upload sessions](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/upload-session-finish),
[moves](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/move-v-2).
