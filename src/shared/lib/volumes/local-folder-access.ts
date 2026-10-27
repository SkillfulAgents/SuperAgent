import fs from 'fs'
import { errnoCode } from '@shared/lib/agent-actor/local-file-ops'

/**
 * Access to the folders local drives point at, where the App Sandbox only lets
 * this process read a folder through the security-scoped bookmark made when the
 * person picked it. The Mac App Store build's main process installs the starter
 * (Electron's `app.startAccessingSecurityScopedResource`); every other install
 * reads folders by path and installs nothing, so every folder counts as open.
 *
 * A folder opens the first time a drive reads it and stays open until the app
 * quits, as a direct install's folders always are: a drive is read at any time
 * (the agent's mount, Settings, its health check), so opening and closing
 * around each read would put this in every file operation, and opening them all
 * at launch would put work on the boot path for drives that may not be used.
 *
 * Only a folder that listed is kept open. Anything else is tried again on the
 * next read, since it can change while the app runs: a disk is plugged back in,
 * the folder's permissions are fixed, or the person picks the folder again.
 */

/** Starts access from a bookmark and returns the function that stops it. */
export type StartFolderAccess = (bookmark: string) => () => void

let startAccess: StartFolderAccess | null = null
/** Open bookmarks and how to close them. Keyed by bookmark: one folder opens once, whatever path it was read by. */
const opened = new Map<string, () => void>()
/** Bookmarks already reported as not opening their folder, so a drive read again and again warns once a run. */
const warned = new Set<string>()

/** Installed by main in the Mac App Store build, before the API serves anything. */
export function setFolderAccessStarter(start: StartFolderAccess | null): void {
  startAccess = start
}

/**
 * Lists the folder once. Its metadata is readable either way, so only reading
 * it tells whether access began. EPERM is the sandbox refusing; EACCES is the
 * folder's own permissions, and ENOENT a folder that is gone (or a disk that is
 * unplugged), which picking it again won't fix.
 */
function listFolder(folder: string): 'listed' | 'refused' | 'unreadable' {
  try {
    fs.opendirSync(folder).closeSync()
    return 'listed'
  } catch (error) {
    return errnoCode(error) === 'EPERM' ? 'refused' : 'unreadable'
  }
}

function warnOnce(bookmark: string, message: string, error?: unknown): void {
  if (warned.has(bookmark)) return
  warned.add(bookmark)
  if (error === undefined) console.warn(message)
  else console.warn(message, error)
}

/**
 * Whether this process can read a local drive's folder, opening it through its
 * bookmark first where the sandbox needs that. False means the person has to
 * pick the folder again: there is no bookmark, or it no longer opens the folder.
 */
export function openLocalFolder(bookmark: string | undefined, folder: string): boolean {
  if (!startAccess) return true
  if (!bookmark) return false
  if (opened.has(bookmark)) return true
  let stop: () => void
  try {
    stop = startAccess(bookmark)
  } catch (error) {
    warnOnce(bookmark, '[volumes] A local drive’s folder bookmark no longer resolves; the folder has to be picked again:', error)
    return false
  }
  // Electron hands back a stop function even for a bookmark that resolves to
  // nothing, so whether access began shows only in reading the folder.
  const listing = listFolder(folder)
  if (listing === 'listed') {
    opened.set(bookmark, stop)
    return true
  }
  stop()
  if (listing === 'refused') {
    warnOnce(bookmark, `[volumes] A local drive’s folder bookmark no longer opens ${folder}; the folder has to be picked again`)
    return false
  }
  // The drive's own read reports a folder that is gone or that its permissions close.
  return true
}

/** Stops every folder's access, when the app quits. */
export function closeLocalFolders(): void {
  for (const stop of opened.values()) {
    try {
      stop()
    } catch {
      // Best effort: the process is exiting.
    }
  }
  opened.clear()
  warned.clear()
}
