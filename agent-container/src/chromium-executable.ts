import * as fs from 'fs'

const CHROMIUM_PATH = '/opt/playwright-browsers/chromium-current'

/**
 * Return the path to the Chromium binary, or null if the stable symlink
 * created at build time is missing or non-executable. The parameter is a
 * seam for the build-time assert script to probe a different path if
 * needed — default is the canonical container location.
 */
export function resolveChromiumExecutable(
  binPath: string = CHROMIUM_PATH
): string | null {
  try {
    fs.accessSync(binPath, fs.constants.X_OK)
    return binPath
  } catch {
    return null
  }
}
