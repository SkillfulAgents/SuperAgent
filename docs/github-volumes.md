# GitHub drives

Choose GitHub in the drive dialog, connect an account, then select a repository, branch and folder.
Selecting the branch root includes the whole repository.
Only the connected account's owner can browse repositories or create the drive.
The definition stores the repository's numeric ID, branch and folder, plus display names.
Reads use that ID, so a repository rename or transfer preserves its identity.
Commits name the repository by the owner and name saved at creation, which GitHub's GraphQL API resolves after a rename.
The label uses names saved at creation.
Agents' changes are committed straight to the selected branch.
An attachment set to read only mounts with rclone's `--read-only` option.

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
Missing or null-base state causes a fresh copy, unless `edits.json` holds changes GitHub does not have: then the drive refuses to copy again rather than lose them.

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

## Writes and pushes

A write, delete or move changes the copy at once and records the path in validated `edits.json`, which the app writes atomically.
A push follows 15 seconds after the last change, or 2 minutes after the first unpushed one.
Each commit goes through `createCommitOnBranch` with the base commit as its expected head, so it lands only if the branch has not moved.
Changes are split into commits of at most 700 KB; a move's two sides travel together.
The commit message names the agents whose changes it carries, and each of them gets one proxy audit row for it.

When the branch moved, the drive pulls, merges, and tries again, up to three times.
A lost reply is told from a refusal by reading the head again.
A refusal at an unmoved head (a protected branch, a revoked account) stops pushes and shows `Sync stopped`; the next use of the drive retries it.

A write merges three ways against the first version that mount was served since its last write, or what it last sent, so a teammate's change pulled meanwhile survives.
The same holds when a pull meets a path with unpushed changes.
Overlapping lines become conflict markers labelled with how to resolve them, and the agent gets a hint when it reads or edits the file.
The drive records each label it writes in `edits.json`, and a push holds a file only while one of those labels is still in it: the same text in any other file pushes.
An edit against a delete on either side, and a binary file changed on both sides, are held without markers.
Deleting a conflicted file keeps GitHub's version.

These stay local and show as not synced: paths a `.gitignore` matches (including those above a subfolder drive), `.git` folders, `.github/workflows/`, files over 700 KB, and paths GitHub tracks as links or submodules.
A path GitHub has that the pull cannot place waits instead of pausing the drive: a local file GitHub has just added too (a conflict), or a folder where GitHub now has a file, or the reverse.
The rest of the pull applies, edits at, under or over such a path wait with it, and it is tried again once the way is clear or the agent edits it.

A version GitHub lacks that a later merge may need waits in `versions/` under the drive's folder until nothing names it or GitHub has it.
None is held in memory, and the folder is cleared on load.

On a disk that ignores case, each part of a written path takes the spelling GitHub tracks or the copy already has, so a push never adds a second spelling of a folder.

The drive card's status pill replaces OK with `N conflicts`, `N not synced`, `Sync paused` or `Sync stopped`, and its tooltip lists the files and why.
Deleting a drive with changes GitHub does not have says how many files will be lost.

## Access and lifecycle

The driver delegates listing, stat and streaming reads to `LocalMountableVolume`.
Reads support byte ranges; reading an unpushed file under 700 KB keeps its version for a later merge.
Credentials remain on the host, and GitHub calls use the existing connected-account provider and request pacer.
The drive uses the local cache mode, whose directory listings expire after one second.

Detaching keeps the copy and its unpushed changes.
Deleting an unattached definition stops its sync owner and removes its folder.
Symlinks and submodules are omitted.
Git LFS files contain their repository pointer text.
The copy has no `.git` directory.
