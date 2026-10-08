# Google Drive volumes

In Settings → Volumes → Add volume, or an agent's Volumes → Add Mount → New Volume,
choose Google Drive. The setup shows account selection or connection first, through
the same account step Dropbox uses; Next opens the name, folder, and access step.
The folder picker lists My Drive and each shared drive at its top level, then the
subfolders of whatever is opened. A folder must be chosen: the top level itself
cannot be mounted. Changing accounts clears the previous folder selection. The
details step says that Google Docs, Sheets and Slides appear as converted copies,
and that saving one creates a separate file next to it.

A definition stores `{ accountId, folderId, folderName, driveName }` in the existing
validated volume config, never OAuth credentials. The folder ID survives renames and
moves in Drive, including across drives; a shared drive's root folder ID is the drive
ID. The server reads both names from Drive on save and ignores the client's. The
volume's label reads `Google Drive · <drive> / <folder>`. Only the
account owner can browse it or create a source from it. Private/public rules, the
attachment grant, the WebDAV route and the audit log are as for
[Dropbox volumes](dropbox-volumes.md): every Drive request made for an agent is
written to the API audit log with the actual agent and connected account, and no
Google credential reaches the agent container.

`GoogleDriveMountableVolume` implements the existing filesystem interface. All of
its Drive calls go to `www.googleapis.com/drive/v3` through the connected account's
provider with `supportsAllDrives=true`, and listings add `includeItemsFromAllDrives=true`.

- Paths never reach Drive. A path is resolved to a Drive ID by walking cached raw
  listings (name, ID, type) from the attached folder, applying the folder view's
  naming rules at each step. Resolving a path exports nothing. Raw listings are
  kept for 15 seconds in the shared remote listing cache, keyed by account and
  folder ID, so case never matters and overlapping volumes share listings.
- The folder view decides every name, in this order: trashed entries, shortcuts
  and Google types with no round-trip export (Forms, Drawings, Sites, Maps) are hidden,
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
  listed or the file itself is opened, at most eight exports at a time per listing.
  The export's bytes are kept, keyed by account, file ID and `modifiedTime`, oldest
  dropped first past 100 MB, and a read serves those bytes. Drive's `.xlsx` and
  `.pptx` exports differ from one export to the next, sometimes in size, so a
  second export could not serve the size the listing reported.
  Drive refuses exports over 10 MB: such a file is hidden from the listing and the
  refusal is remembered for that version. A transient export failure (rate limit,
  5xx) fails that listing, keeping sizes already learned, so rclone retries.
- Regular files are read as current content with byte ranges. Any read whose bytes
  are fewer or more than the listed size fails rather than serve a cut or mixed
  file; rclone retries, and the next listing corrects the size.
- A write resolves its target through the folder view. A visible regular file is
  updated as a new revision, a visible folder is refused, and any other name creates
  a new real file in the parent. A visible export updates the Google file itself:
  the upload carries the export format, Drive converts it back, and the file ID
  stays the same. A saved Doc keeps text, headings, lists, links, tables, images
  and comments, and loses text colors, fonts and alignment. A Doc with several tabs
  becomes one tab, each old tab's title a heading. A pending suggestion does not stay
  a suggestion. Drive's version history keeps the Doc as it was before the save.
  Uploads use Drive's resumable upload in 512 KiB chunks,
  the largest Composio's proxy mode accepts. If the client stops waiting (rclone
  cancels an upload when the file is renamed mid-upload), the upload is never
  finished and Drive discards it.
- A request Drive refuses for a rate limit was not applied, so any request, change
  or read, is tried three times, a second and then two seconds apart. Reads also
  retry server errors. Changes never do, since a change may have been applied. The
  connection's Google project shares one per-minute quota across its users, so
  refusals come even at low rates.
- rclone mounts Drive volumes with `--ignore-size`, because a converted file's
  stored size never matches the uploaded bytes and rclone would otherwise delete it.
  The volume checks plain uploads itself: Drive must report the full size.
- Name checks before a folder is made or a file moved, and the not-empty check
  before a delete, use the raw children, including entries the agent cannot see.
  Renaming an export strips the clash suffix and extension to get the Drive name,
  which must keep the extension. Changes from this process run one at a time per
  account. Each re-reads the folders it checks or acts in, and afterwards drops only
  those folders from the cache, so other listings stay cached.
- A regular file moved onto a visible file replaces that file's content, then the
  source is trashed. This is how many tools save (write a temp file, rename it over
  the original). The destination keeps its ID, sharing and history, and a converted
  copy saves into its Google file. A folder, or a converted copy as the source,
  never replaces anything.
- Delete moves to trash. A folder is trashed only when empty, because trashing a
  folder trashes its contents. A move or rename is one update call that changes
  parent and name; a taken destination is a conflict that keeps both entries.
  A trashed attached folder reports not found, so the agent never writes into trash.
- The adapter selects the `remote` cache mode: rclone caches directories for five
  minutes and file reads/writes on disk.

Validation uses a mocked Drive provider behind real SQLite/libSQL volume and WebDAV
routes, a mocked Drive client behind the driver, and browser tests with deterministic
account and folder API responses. Live Google OAuth and a real account are separate
integration checks; the mock tests do not claim to exercise them.

API references: [Drive files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
[export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export),
[resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable),
[shared drives](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives).
