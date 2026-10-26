# GitHub drives

Choose GitHub in the drive dialog, connect an account, then select a repository, branch and folder.
Selecting the branch root includes the whole repository.
Only the connected account's owner can browse repositories or create the drive.
The definition stores the repository's numeric ID, branch and folder, plus display names.
GitHub requests use that ID, so a repository rename or transfer preserves its identity.
The label uses names saved at creation.
Every GitHub drive is read-only.

## Copy and refresh

The first health check, list or read starts copying the selected folder in the background.
Until staging finishes, the drive reports `preparing` through the existing mount-status path.
Initial staging writes directly into `copy/`.
A staging failure reports its reason and removes the partial copy.
A container start waits up to 20 seconds for a drive still making its first copy, so a restart right after adding the drive mounts it.
A drive that misses the start that way marks the agent stale once its copy lands, so the app asks for a restart.
Attachments share one copy at `getDataDir()/volumes/<volume id>/copy/`.
Validated `sync.json` records the base commit and each path's blob SHA and mode.
The app writes that state atomically.
It records the new base after publication finishes.
Missing, invalid or null-base state causes a fresh copy because the drive accepts no local edits.

List and read operations check the branch when the previous check is over 30 seconds old.
A read waits up to 5 seconds for that check, so it shows what a teammate pushed meanwhile; every read waiting on one check shares those 5 seconds.
After the wait, the read serves the current copy and the check finishes in the background.
A changed branch pulls only changed paths, including additions and deletions.
Up to 32 added or changed files totalling at most 8 MB come one by one through the blobs endpoint.
More, or larger, stream one tarball into a temporary pull folder; either way only changed paths are published.
Unchanged and delete-only pulls download nothing.
Initial staging follows the same rule, checked against the tree from the same commit.

The tree comes from one recursive listing of the drive's folder.
A subfolder drive lists each folder above it alone, never the whole repository.
A folder too large for one listing (about 50,000 entries) is listed folder by folder, 8 at a time.
`trees.json` keeps that walk's listings by tree SHA, so the next walk asks GitHub only for folders whose SHA changed.
It is a cache: missing or unreadable means a full walk.
Every listing completes before any change applies.
Files omitted by `export-ignore` or rewritten by `export-subst` are fetched by blob SHA through the base64 blobs endpoint.
SHA verification preserves file contents exactly.

Each incoming tree must fit the host disk's case rules, including parent folder names.
A clash refuses initial staging or stops a pull before changing the copy.
The access error names both colliding paths.
Mount health reports `not accessible`.
A deleted branch or revoked account stops pulling and logs the reason.
The drive continues serving its last copy in those cases.
Transient failures use the existing request pacer's backoff and can retry on a later read or listing.
Health checks also retry failed first copies.

## Access and lifecycle

The driver delegates listing, stat and streaming reads to `LocalMountableVolume`.
Reads support byte ranges and do not record served versions or write sync state.
The container mount list marks the drive read-only, so rclone uses its existing `--read-only` option.
The driver also refuses write, delete, mkdir and move operations.
Credentials remain on the host, and GitHub calls use the existing connected-account provider and request pacer.
The drive uses the local cache mode, whose directory listings expire after one second.

Detaching keeps the copy.
Deleting an unattached definition stops its sync owner and removes its folder.
There are no commits, merges, held files or mutation audit rows in this slice.
Symlinks and submodules are omitted.
Git LFS files contain their repository pointer text.
The copy has no `.git` directory.
