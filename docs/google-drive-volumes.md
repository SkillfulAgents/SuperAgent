# Google Drive volumes

In Settings → Volumes → Add volume, or an agent's Volumes → Add Mount → New Volume,
choose Google Drive. The setup shows account selection or connection first, through
the same account step Dropbox uses; Next opens the name, folder, and access step.
The folder picker lists My Drive and each shared drive at its top level, then the
subfolders of whatever is opened. A folder must be chosen: the top level itself
cannot be mounted. Changing accounts clears the previous folder selection. The
details step says that Google Docs, Sheets and Slides appear as converted copies,
and that saving a converted copy updates the original Google file.

A definition stores `{ accountId, folderId, folderName, driveName }` in the existing
validated volume config, never OAuth credentials. The folder ID survives renames and
moves in Drive, including across drives; a shared drive's root folder ID is the drive
ID. The server reads both names from Drive on save and ignores the client's. The
volume's label reads `Google Drive · <drive> / <folder>`. Only the
account owner can browse it or create a source from it. Private/public rules, the
attachment grant, the WebDAV route and the audit log are as for
[Dropbox volumes](dropbox-volumes.md): published mutations are audited with the
actual agent and connected account; reads and upload staging are not. Filesystem
traffic never emits product analytics. No Google credential reaches the agent
container. Authorization and attribution are shared across the pages/chunks of
one operation, and upload publication rechecks account access.

`GoogleDriveMountableVolume` implements the existing filesystem interface. All of
its Drive calls go to `www.googleapis.com/drive/v3` through the connected account's
provider with `supportsAllDrives=true`, and listings add `includeItemsFromAllDrives=true`.

- Paths never reach Drive. A path is resolved to a Drive ID by walking cached raw
  listings (name, ID, type) from the attached folder, applying the folder view's
  naming rules at each step. Resolving a path exports nothing. Raw listings are
  kept for 15 seconds in the shared remote listing cache, keyed by account and
  folder ID, so overlapping volumes share listings without folding file-name case.
- While a Drive volume is in use, the app polls Drive's account-wide change feed at
  most every 3 seconds. A poll that finds nothing touching a cached folder keeps its
  listing current as of 10 seconds before the poll, since changes reached the feed
  2-5 seconds after Drive confirmed them. A listing a change touches is dropped and
  read again. Only listings read after the feed started are kept this way. A failed
  poll is tried again from the same place. A poll that would page past 3,000 changes
  drops the cached listings, and a minute without a successful poll restarts the feed.
  Drive keeps an expired listing for a minute. A read that finds one the feed can still
  vouch for waits for the poll in flight instead of reading the folder again.
- A tree walk lists a folder soon after its parent. When one does, the parent's other
  subfolders and this folder's subfolders are listed ahead of it, 4 at a time per
  account and at most 32 per listing. A single listing reads nothing extra.
- A shortcut shows as its target under the shortcut's own name, like a subfolder or
  file of the folder it sits in, wherever the target lives. Reads and writes reach the
  target. Delete and move act on the shortcut, so the target is never trashed through
  it. A shortcut to a folder above it is listed but cannot be entered, so the tree
  never loops. Each shortcut costs one target lookup per listing.
- The folder view decides every name, in this order: trashed entries, shortcuts
  whose target is gone or not accessible, and Google types with no round-trip export (Forms, Drawings, Sites, Maps) are hidden,
  as are files whose downloads are blocked for this account, shortcuts with
  a warning; Google files whose export is known to exceed 10 MB are hidden; entries
  named `.` or `..` are hidden; `/` in a name shows as `／` (fullwidth slash), for
  display only; Google files get their export extension; an export whose name
  matches a real entry shows as `<name> (Google Doc).<ext>` (or Sheet, Slides),
  or, if a real file holds that name too, with the file's ID in the
  suffix, so a real file never hides a Google file; and of any name still used twice, the newest by modified time is shown
  and the rest are hidden with a warning. Names are case-sensitive, as Drive is.
- Google Docs read as `.md`, Sheets as `.xlsx`, and Slides as `.pptx`, with correct
  sizes. A Google file is exported only when its folder is
  listed or the file itself is opened. Concurrent requests for one version share
  the export; all listings share a limit of 16 exports in flight. Bytes are keyed
  by account, file ID and version (falling back to `modifiedTime`), with oldest
  bytes dropped past 100 MiB. Sizes have a separate 8,000-entry cache, and each
  listing retains its own size snapshot. Byte or metadata eviction therefore
  cannot break a large listing. A read reuses retained bytes or re-exports an
  evicted file and reports the size of those newly exported bytes. Drive's `.xlsx` and
  `.pptx` exports differ from one export to the next, sometimes in size, so a
  second export may differ from the size a previous listing reported.
  Drive refuses exports over 10 MB: such a file is hidden from the listing and the
  refusal is remembered for that version. A transient export failure (rate limit,
  5xx) fails that listing, keeping sizes already learned, so rclone retries.
- Explicit file stats and reads refresh metadata, even after a cached listing.
  Regular files are read as current content with byte ranges. Any read whose bytes
  are fewer or more than the listed size fails rather than serve a cut or mixed
  file; rclone retries, and the next listing corrects the size.
- On a Composio-managed connection, Composio's proxy returns a text or JSON download
  decoded: JSON re-serialized (large numbers rounded), bytes that are not UTF-8
  replaced, a byte-order mark dropped, sometimes at the same length. Such a file
  cannot be read exactly once rclone has not cached it. When Drive confirms the file
  is the listed size, a body of another length, or a whole file whose MD5 differs
  from Drive's `md5Checksum`, is refused before any header goes out. That version is
  remembered, so rclone's retries fail without another download. The agent sees an
  I/O error, and the app log says why. Valid UTF-8 text,
  binary files and Google file exports read exactly. A connection through our own
  Google OAuth app would fetch from Google directly and avoid this.
- A write resolves its target through the folder view. A visible regular file is
  updated as a new revision, a visible folder is refused, and any other name creates
  a new real file in the parent. A visible export updates the Google file itself:
  the upload carries the export format, Drive converts it back, and the file ID
  stays the same. A saved Doc keeps text, headings, lists, links, tables, images
  and comments, and loses text colors, fonts and alignment. A Doc with several tabs
  becomes one tab, each old tab's title a heading. A pending suggestion does not stay
  a suggestion. Drive's version history keeps the Doc as it was before the save.
  Uploads through 512 KiB use one `multipart/related` content request, including
  empty files, overwrites and Google-file imports. Metadata and bytes travel
  together through Composio as opaque binary data. Larger uploads use resumable
  512 KiB chunks, keeping the base64 request below the platform limit. Cancellation
  stops body reads/staging and is checked again before publication.
- A request Drive refuses for a rate limit was not applied, so any request, change
  or read, uses the same account-wide cooldown and bounded pacer as Dropbox:
  Retry-After (seconds or HTTP date), exponential backoff, at most four attempts
  and ten seconds of waiting. Longer cooldowns return 429 with Retry-After
  immediately. Safe reads also retry transient server/transport errors. Changes
  never replay uncertain failures, since a change may have been applied. The
  connection's Google project shares one per-minute quota across its users, so
  refusals come even at low rates.
- rclone mounts Drive volumes with `--ignore-size`, because a converted file's
  stored size never matches the uploaded bytes and rclone would otherwise delete it.
  The volume checks plain uploads itself: Drive must report the full size.
- Name checks before a folder is made or a file moved, and the not-empty check
  before a delete, use the raw children, including entries the agent cannot see.
  Renaming an export strips the clash suffix and extension to get the Drive name,
  which must keep the extension. A change waits only for earlier changes to the
  same folders or target file IDs, including aliases reached through shortcuts.
  Changes to unrelated files/folders can proceed independently. A file's bytes
  upload outside that wait, and only the final step, which makes the change, waits
  its turn after checking fresh parent/name metadata and the target version.
  Folder creation may reuse a listing for 5 seconds; deletes and moves also
  re-read their folders. Drive lacks a conditional name create/content update:
  these checks detect changes during staging, but cannot eliminate an external
  client racing the final preflight and API call. After a change, the
  cached listing is updated with what Drive returned instead of being read again.
  A followed shortcut keeps its own name and ID in that update.
- rclone asks to make a file's folder before every upload. A folder that already
  exists answers from the cached listing, without a Drive call.
- A regular file moved onto a visible file replaces that file's content, then the
  source is trashed. This is how many tools save (write a temp file, rename it over
  the original). The destination keeps its ID, sharing and history, and a converted
  copy saves into its Google file. A folder, or a converted copy as the source,
  never replaces anything. A move between two names of the same file, such as a
  file and a shortcut to it, does nothing. A replacement downloads and validates
  the source size/checksum outside the mutation locks, then checks both source
  and destination versions before publication. Corrupt or truncated content
  cannot replace the destination. The source is rechecked before trashing, so
  an edit discovered then is retained. Drive has no atomic copy-and-trash or
  conditional trash; external changes can still race the final preflight.
- Failed or cancelled uploads use the shared cleanup protection described in
  [Dropbox volumes](dropbox-volumes.md). The subsequent cleanup DELETE returns
  409, rather than silently succeeding or becoming destructive after five seconds.
  A newly created file cancelled during publication is trashed only if its current
  version still matches the upload result; an external replacement is preserved.
- Advisory Settings/mount health checks share Dropbox's policy: coalesced per
  account/root, cached for 60 seconds on success or 5 seconds on failure. Every
  call rechecks account access; mutation and account-version changes invalidate
  health. Filesystem operations bypass this advisory cache.
- Drive mounts trust a folder listing for 30 seconds, not the 5 minutes of other
  remote mounts, because people edit Drive files in Google's editors while agents
  work. rclone ends each read at the size it last listed. A read that ends short of a
  file's current end can only come from a stale size, so the WebDAV route answers
  416. The agent sees an I/O error until the folder is listed again, never a file
  cut short.
- Delete moves to trash. A folder is trashed only when empty, because trashing a
  folder trashes its contents. A move or rename is one update call that changes
  parent and name when the destination is free. Occupied files use the verified
  replacement flow above; occupied folders are refused.
  A trashed attached folder reports not found, so the agent never writes into trash.
- The adapter selects the `remote` cache mode with the 30-second directory
  override above and file reads/writes on disk.

Both providers register the same filesystem and remote-client contract suites in
`src/shared/lib/volumes/testing/`. A new adapter supplies a wire-level provider
fixture with independent remote-state assertions and failure injection. Provider
regressions remain separate: Drive exports, shortcuts, conversions and checksummed
rename transfers; Dropbox revisions and backup/rollback renames.

Validation uses a mocked Drive provider behind real SQLite/libSQL volume and WebDAV
routes, a mocked Drive client behind the driver, and browser tests with deterministic
account and folder API responses. Live Google OAuth and a real account are separate
integration checks; the mock tests do not claim to exercise them.

API references: [Drive files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
[export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export),
[resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable),
[shared drives](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives).
