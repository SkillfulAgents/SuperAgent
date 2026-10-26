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
 */

/** Starts access from a bookmark and returns the function that stops it. */
export type StartFolderAccess = (bookmark: string) => () => void

let startAccess: StartFolderAccess | null = null
/** Open bookmarks and how to close them. Keyed by bookmark: one folder opens once, whatever path it was read by. */
const opened = new Map<string, () => void>()
/** Bookmarks that opened nothing this run. Retrying won't help: the person has to pick the folder again. */
const failed = new Set<string>()

/** Installed by main in the Mac App Store build, before the API serves anything. */
export function setFolderAccessStarter(start: StartFolderAccess | null): void {
  startAccess = start
}

/**
 * Whether the sandbox lets this process list the folder. Its metadata is
 * readable either way, so only reading it tells. A folder that is gone counts
 * as reachable: the drive reports it missing, which picking again won't fix.
 */
function sandboxAllowsListing(folder: string): boolean {
  try {
    fs.opendirSync(folder).closeSync()
    return true
  } catch (error) {
    const code = errnoCode(error)
    return code !== 'EPERM' && code !== 'EACCES'
  }
}

/**
 * Whether this process can read a local drive's folder, opening it through its
 * bookmark first where the sandbox needs that. False means the person has to
 * pick the folder again: there is no bookmark, or it no longer opens the folder.
 */
export function openLocalFolder(bookmark: string | undefined, folder: string): boolean {
  if (!startAccess) return true
  if (!bookmark || failed.has(bookmark)) return false
  if (opened.has(bookmark)) return true
  let stop: () => void
  try {
    stop = startAccess(bookmark)
  } catch (error) {
    failed.add(bookmark)
    console.warn('[volumes] A local drive’s folder bookmark no longer resolves; the folder has to be picked again:', error)
    return false
  }
  // Electron hands back a stop function even for a bookmark that resolves to
  // nothing, so whether access began shows only in reading the folder.
  if (!sandboxAllowsListing(folder)) {
    stop()
    failed.add(bookmark)
    console.warn(`[volumes] A local drive’s folder bookmark no longer opens ${folder}; the folder has to be picked again`)
    return false
  }
  opened.set(bookmark, stop)
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
  failed.clear()
}
