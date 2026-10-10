# Mounted volume shutdown

Every agent stop uses the same bounded preparation, including restart, deletion, idle sleep and app quit. The container stops writers and tries to finish uploads for at most 15 seconds. It then has up to three seconds to finalize its workspace cache; the host bounds the whole request to 20 seconds. A failed drain never refuses the stop or requires a force confirmation.

When uploads remain, the container kills rclone to freeze its cache and moves that cache into `recovered-volume-uploads/<volume-id>-<generation>/` in the agent workspace. The host reports an incomplete drain or recovery failure to Sentry, using counts and the agent ID, without filenames or file contents, then continues normal shutdown.

The cache is stored under `.volume-cache/` in the persistent workspace from the start. Promotion to the recovery folder is a same-filesystem rename, so large files do not need to be copied during shutdown. If the API is unreachable or promotion fails, the original cache remains there. Successful drains remove the working cache. Recovery directories are never overwritten or automatically replayed onto the provider.

Each preserved cache has `volume.json` identifying the original mount, `vfs/` with cached file bytes, and `vfsMeta/` with rclone's dirty flags and cached ranges. Closed queued uploads contain the full file; interrupted writes and partially cached existing files may need those ranges and the remote original to reconstruct the file. Keep the metadata with the bytes. These files have the same lifetime as the agent workspace; deleting the agent also deletes its workspace.

App shutdown keeps credentials available while agents finish their bounded stops. The existing runtime stop/kill escalation and app exit behavior then continue. Older images without the preparation endpoint retain their existing behavior; workspace recovery requires the updated agent image. No mount-definition migration or UI change is needed.
