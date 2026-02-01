import fs from 'fs'
import path from 'path'
import os from 'os'

const PROFILE_FILES = ['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal']
const PROFILE_DIRS = ['Local Storage', 'Session Storage']

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
export function listChromeProfiles(): Array<{ id: string; name: string }> {
  const dataDir = getChromeUserDataDir()
  if (!dataDir) return []

  try {
    const localStatePath = path.join(dataDir, 'Local State')
    if (!fs.existsSync(localStatePath)) return []

    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'))
    const infoCache = localState?.profile?.info_cache
    if (!infoCache || typeof infoCache !== 'object') return []

    return Object.entries(infoCache).map(([id, info]) => ({
      id,
      name: (info as { name?: string }).name || id,
    }))
  } catch {
    return []
  }
}

/**
 * Copies session data (cookies, login data, local/session storage) from a
 * Chrome profile into a destination directory.
 *
 * @param profileId - Chrome profile directory name (e.g. "Default", "Profile 1")
 * @param destDir - Destination directory to copy files into
 * @returns true if files were copied, false if source profile wasn't found
 */
export function copyChromeProfileData(profileId: string, destDir: string): boolean {
  const chromeDataDir = getChromeUserDataDir()
  if (!chromeDataDir) return false

  const profileSourceDir = path.join(chromeDataDir, profileId)
  if (!fs.existsSync(profileSourceDir)) return false

  fs.mkdirSync(destDir, { recursive: true })

  for (const file of PROFILE_FILES) {
    const src = path.join(profileSourceDir, file)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, file))
    }
  }

  for (const dir of PROFILE_DIRS) {
    const src = path.join(profileSourceDir, dir)
    const dest = path.join(destDir, dir)
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true })
    }
  }

  return true
}
