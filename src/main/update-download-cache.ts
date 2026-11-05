import fs from 'fs'
import path from 'path'
import { pendingUpdateInfoSchema } from './update-download-cache-schema'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const semver = require('semver') as typeof import('semver')

/**
 * The version in a mac update zip's name: `Gamut-<version>-<arch>.zip`, the
 * mac `artifactName` in package.json. Null for any other name.
 */
export function versionInUpdateFileName(fileName: string): string | null {
  const match = /^[^-]+-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-[0-9A-Za-z_]+\.zip$/.exec(fileName)
  return match && semver.valid(match[1]) ? match[1] : null
}

/**
 * Removes the download of an update that is already installed.
 *
 * On macOS electron-updater keeps two copies of each update zip.
 * - `pending/<file>.zip` is the download. It is read only to install it, and
 *   electron-updater empties `pending/` when the next download starts.
 * - `update.zip` in the folder above is the base that the next update's
 *   partial download compares against. This keeps it.
 *
 * Once the update is installed, the pending copy is dead weight: the app's
 * size again on disk, over 1 GB once the app ships the agent image. This
 * removes it when the running app is that version or newer. A downloaded
 * update that isn't installed yet stays, and so does anything it can't read.
 *
 * Never throws. Returns whether it removed anything.
 */
export async function removeInstalledUpdateDownload(pendingDir: string, runningVersion: string): Promise<boolean> {
  let fileName: string
  try {
    fileName = pendingUpdateInfoSchema.parse(JSON.parse(await fs.promises.readFile(path.join(pendingDir, 'update-info.json'), 'utf8'))).fileName
  } catch {
    return false // nothing downloaded, or a record this can't read
  }
  const version = versionInUpdateFileName(fileName)
  if (!version || !semver.valid(runningVersion) || semver.gt(version, runningVersion)) return false
  try {
    const bytes = await fs.promises.stat(path.join(pendingDir, fileName)).then((s) => s.size, () => 0)
    // The whole folder, as electron-updater empties it; it recreates it for the next download.
    await fs.promises.rm(pendingDir, { recursive: true, force: true })
    console.log(`[auto-updater] Removed the download of installed update ${version} (${Math.round(bytes / 1048576)} MiB)`)
    return true
  } catch (error) {
    console.warn('[auto-updater] Could not remove the installed update download:', error)
    return false
  }
}
