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
export const PROFILE_SYNC_MANIFEST = '.superagent-profile-sync.json'
const COPY_CONCURRENCY = 16

/**
 * Where a profile sync lands. The source is always a Chrome profile on this
 * machine; the destination is a directory on this machine (the host browser's
 * own profile) or an agent's workspace, reached through its actor, which is
 * why the sync never spells a destination path itself. Relative paths are
 * posix, relative to the destination root.
 */
export interface ProfileSyncDestination {
  /** The previous sync's manifest text, or null when there is none. */
  readManifest(): Promise<string | null>
  /** Store the manifest; it is host bookkeeping the agent never needs. */
  writeManifest(text: string): Promise<void>
  /** Whether a regular file is at this path. */
  hasFile(relativePath: string): Promise<boolean>
  /**
   * Replace the file at `relativePath` with the host file at `sourcePath`,
   * creating parents. A source that vanished since it was fingerprinted is
   * not an error: a running Chrome deletes transient files (SQLite hot
   * journals, leveldb tables) at any time, and the next sync's source scan
   * simply will not include it.
   */
  copyFile(sourcePath: string, relativePath: string): Promise<void>
}

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
 * local/session storage) from a Chrome profile into a destination.
 * A source-metadata manifest makes subsequent syncs incremental: files are
 * copied only when the selected source profile changed or a destination file
 * disappeared. Destination files modified by the agent are therefore kept
 * when the user's source profile is unchanged.
 *
 * @param profileId - Chrome profile directory name (e.g. "Default", "Profile 1")
 * @param destination - A directory on this machine, or a `ProfileSyncDestination`
 * @returns true if the source profile exists, false otherwise
 */
export async function copyChromeProfileData(
  profileId: string,
  destination: string | ProfileSyncDestination,
): Promise<boolean> {
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

  const target = typeof destination === 'string' ? hostDirectoryDestination(destination) : destination
  const [previousManifest, sourceFiles] = await Promise.all([
    readProfileSyncManifest(target),
    collectSourceFiles(profileSourceDir),
  ])
  const previousFiles = previousManifest?.profileId === profileId
    ? previousManifest.files
    : {}

  const entries = Object.entries(sourceFiles)
  await forEachConcurrent(entries, COPY_CONCURRENCY, async ([relativePath, fingerprint]) => {
    const unchanged = fingerprintsEqual(previousFiles[relativePath], fingerprint)
    if (unchanged && await target.hasFile(relativePath)) {
      return
    }
    await target.copyFile(path.join(profileSourceDir, relativePath), relativePath)
  })

  const nextManifest: ProfileSyncManifest = {
    version: 1,
    profileId,
    files: sourceFiles,
  }
  if (!manifestsEqual(previousManifest, nextManifest)) {
    await target.writeManifest(JSON.stringify(nextManifest))
  }

  return true
}

/** A sync destination that is a directory on this machine. */
export function hostDirectoryDestination(destDir: string): ProfileSyncDestination {
  return {
    readManifest: async () => {
      try {
        return await fs.promises.readFile(path.join(destDir, PROFILE_SYNC_MANIFEST), 'utf8')
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    writeManifest: async (text) => {
      await fs.promises.mkdir(destDir, { recursive: true })
      await writeFileAtomic(path.join(destDir, PROFILE_SYNC_MANIFEST), text, { mode: 0o600 })
    },
    hasFile: async (relativePath) => {
      try {
        return (await fs.promises.stat(path.join(destDir, ...relativePath.split('/')))).isFile()
      } catch (error) {
        if (isNotFound(error)) return false
        throw error
      }
    },
    copyFile: async (sourcePath, relativePath) => {
      const destinationPath = path.join(destDir, ...relativePath.split('/'))
      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true })
      try {
        await fs.promises.copyFile(sourcePath, destinationPath)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    },
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Relative paths of the source files, in posix form so a destination of any kind can take them. */
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
    const relativePath = `${relativeDir}/${entry.name}`
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
async function readProfileSyncManifest(destination: ProfileSyncDestination): Promise<ProfileSyncManifest | null> {
  const raw = await destination.readManifest()
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = ProfileSyncManifestSchema.safeParse(parsed)
  return result.success ? result.data : null
}

function fingerprintsEqual(
  left: ProfileFileFingerprint | undefined,
  right: ProfileFileFingerprint,
): boolean {
  return left !== undefined
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function manifestsEqual(
  left: ProfileSyncManifest | null,
  right: ProfileSyncManifest,
): boolean {
  if (!left || left.version !== right.version || left.profileId !== right.profileId) return false
  const leftEntries = Object.entries(left.files)
  const rightEntries = Object.entries(right.files)
  if (leftEntries.length !== rightEntries.length) return false
  return rightEntries.every(([relativePath, fingerprint]) => fingerprintsEqual(left.files[relativePath], fingerprint))
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}
