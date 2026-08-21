import fs from 'fs'
import path from 'path'
import os from 'os'
import { writeFileAtomic } from '@shared/lib/utils/file-storage'
import {
  ProfileSyncManifestSchema,
  type ProfileFileFingerprint,
  type ProfileSyncManifest,
} from './chrome-profile-schema'

export interface ChromeProfile {
  id: string
  name: string
  avatarUrl?: string
  email?: string
}

const PROFILE_FILES = ['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal', 'Web Data', 'Web Data-journal']
const PROFILE_DIRS = ['Local Storage', 'Session Storage']
const PROFILE_SYNC_MANIFEST = '.superagent-profile-sync.json'
const COPY_CONCURRENCY = 16

/**
 * Returns the platform-specific Chrome user data directory, or null if not found.
 */
export function getChromeUserDataDir(): string | null {
  const platform = process.platform
  let dir: string
  if (platform === 'darwin') {
    dir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  } else if (platform === 'linux') {
    dir = path.join(os.homedir(), '.config', 'google-chrome')
  } else if (platform === 'win32') {
    dir = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
  } else {
    return null
  }
  return fs.existsSync(dir) ? dir : null
}

/**
 * Lists Chrome profiles by reading Local State JSON.
 */
export function listChromeProfiles(): ChromeProfile[] {
  const dataDir = getChromeUserDataDir()
  if (!dataDir) return []

  try {
    const localStatePath = path.join(dataDir, 'Local State')
    if (!fs.existsSync(localStatePath)) return []

    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'))
    const infoCache = localState?.profile?.info_cache
    if (!infoCache || typeof infoCache !== 'object') return []

    return Object.entries(infoCache).map(([id, info]) => {
      const typed = info as { name?: string; user_name?: string; last_downloaded_gaia_picture_url_with_size?: string }
      return {
        id,
        name: typed.name || id,
        avatarUrl: typed.last_downloaded_gaia_picture_url_with_size || undefined,
        email: typed.user_name || undefined,
      }
    })
  } catch {
    return []
  }
}

/**
 * Asynchronously synchronizes session data (cookies, login data,
 * local/session storage) from a Chrome profile into a destination directory.
 * A source-metadata manifest makes subsequent syncs incremental: files are
 * copied only when the selected source profile changed or a destination file
 * disappeared. Destination files modified by the agent are therefore kept
 * when the user's source profile is unchanged.
 *
 * @param profileId - Chrome profile directory name (e.g. "Default", "Profile 1")
 * @param destDir - Destination directory to copy files into
 * @returns true if the source profile exists, false otherwise
 */
export async function copyChromeProfileData(profileId: string, destDir: string): Promise<boolean> {
  const chromeDataDir = getChromeUserDataDir()
  if (!chromeDataDir) return false

  // Chrome profile IDs are direct children of the user-data directory. Refuse
  // a tampered setting that would make this host-side copy read elsewhere.
  const profileSourceDir = path.resolve(chromeDataDir, profileId)
  if (path.dirname(profileSourceDir) !== path.resolve(chromeDataDir)) return false
  try {
    if (!(await fs.promises.stat(profileSourceDir)).isDirectory()) return false
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }

  const [previousManifest, sourceFiles] = await Promise.all([
    readProfileSyncManifest(destDir),
    collectSourceFiles(profileSourceDir),
  ])
  const previousFiles = previousManifest?.profileId === profileId
    ? previousManifest.files
    : {}

  await fs.promises.mkdir(destDir, { recursive: true })
  const entries = Object.entries(sourceFiles)
  await forEachConcurrent(entries, COPY_CONCURRENCY, async ([relativePath, fingerprint]) => {
    const destinationPath = path.join(destDir, relativePath)
    const unchanged = fingerprintsEqual(previousFiles[relativePath], fingerprint)
    if (unchanged && await isRegularFile(destinationPath)) {
      return
    }
    await copyProfileFile(path.join(profileSourceDir, relativePath), destinationPath)
  })

  const nextManifest: ProfileSyncManifest = {
    version: 1,
    profileId,
    files: sourceFiles,
  }
  if (!manifestsEqual(previousManifest, nextManifest)) {
    await writeFileAtomic(
      path.join(destDir, PROFILE_SYNC_MANIFEST),
      JSON.stringify(nextManifest),
      { mode: 0o600 },
    )
  }

  return true
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function collectSourceFiles(
  profileSourceDir: string,
): Promise<Record<string, ProfileFileFingerprint>> {
  const relativePaths = [...PROFILE_FILES]
  await Promise.all(PROFILE_DIRS.map(
    (relativePath) => collectDirectoryPaths(profileSourceDir, relativePath, relativePaths),
  ))
  const files: Record<string, ProfileFileFingerprint> = Object.create(null)
  await forEachConcurrent(relativePaths, COPY_CONCURRENCY, async (relativePath) => {
    await collectFile(profileSourceDir, relativePath, files)
  })
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
}

async function collectDirectoryPaths(
  profileSourceDir: string,
  relativeDir: string,
  relativePaths: string[],
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(path.join(profileSourceDir, relativeDir), { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }

  await Promise.all(entries.map(async (entry) => {
    const relativePath = path.join(relativeDir, entry.name)
    if (entry.isDirectory()) {
      await collectDirectoryPaths(profileSourceDir, relativePath, relativePaths)
    } else if (entry.isFile()) {
      relativePaths.push(relativePath)
    }
  }))
}

async function collectFile(
  profileSourceDir: string,
  relativePath: string,
  files: Record<string, ProfileFileFingerprint>,
): Promise<void> {
  try {
    const stat = await fs.promises.stat(path.join(profileSourceDir, relativePath))
    if (!stat.isFile()) return
    files[relativePath] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

// The manifest is advisory: any unreadable or invalid state resolves to null
// so the sync falls back to a full re-seed instead of trusting stale data.
async function readProfileSyncManifest(destDir: string): Promise<ProfileSyncManifest | null> {
  let raw: string
  try {
    raw = await fs.promises.readFile(path.join(destDir, PROFILE_SYNC_MANIFEST), 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = ProfileSyncManifestSchema.safeParse(parsed)
  return result.success ? result.data : null
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function copyProfileFile(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true })
  try {
    await fs.promises.copyFile(sourcePath, destinationPath)
  } catch (error) {
    // A running Chrome deletes transient files (SQLite hot journals, leveldb
    // tables) at any time, so a source that vanished after fingerprinting must
    // not fail the sync — and with it the agent start. The next run's source
    // scan simply won't include the file.
    if (!isNotFound(error)) throw error
  }
}

function fingerprintsEqual(
  left: ProfileFileFingerprint | undefined,
  right: ProfileFileFingerprint,
): boolean {
  return left?.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function manifestsEqual(
  left: ProfileSyncManifest | null,
  right: ProfileSyncManifest,
): boolean {
  if (!left || left.profileId !== right.profileId) return false
  const leftPaths = Object.keys(left.files)
  const rightPaths = Object.keys(right.files)
  return leftPaths.length === rightPaths.length
    && rightPaths.every((relativePath) => fingerprintsEqual(left.files[relativePath], right.files[relativePath]))
}

async function forEachConcurrent<T>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const value = values[nextIndex++]
      await work(value)
    }
  })
  await Promise.all(workers)
}
