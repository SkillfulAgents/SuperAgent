import fs from 'node:fs'
import nodeModule from 'node:module'
import path from 'node:path'

/**
 * V8's compile cache for the main process (Node's `module.enableCompileCache`).
 *
 * Main loads a few thousand unbundled files at startup and V8 otherwise
 * compiles each from source on every launch. With the cache on, Node keeps the
 * compiled code of every module it loads in a directory and reuses it on the
 * next launch. An entry is keyed by the file's path and holds a hash of its
 * source, so a file that changed (an app update, a dev rebuild) is recompiled
 * and its entry replaced: nothing here needs to know the app's version. It
 * also works for files inside `app.asar`.
 *
 * It only helps modules loaded after it is turned on, which is why the entry
 * point (`entry.ts`) is a stub that calls this and then loads the real bundle.
 */

/** The cache's own directory under the platform's cache root. Nothing else may live in it. */
const CACHE_DIR_NAME = 'gamut-compile-cache'

/**
 * What the stub may ask Electron's `app`. The type is the rule: `userData`
 * and `sessionData` are resolved from the app's name the first time they are
 * read and never again, and `index.ts` sets that name later. Reading either
 * here would move the Chromium profile (and the dev data directory) to
 * `…/Gamut`. `home` does not depend on the name.
 */
export interface CompileCacheApp {
  isPackaged: boolean
  getPath(name: 'home'): string
}

/** What this module uses of `node:module`; a parameter so a test can stand in for it. */
export interface CompileCacheApi {
  enableCompileCache?: (cacheDir?: string) => { status: number; directory?: string; message?: string }
  getCompileCacheDir?: () => string | undefined
  constants?: { compileCacheStatus?: { ENABLED: number } }
}

/**
 * Where the cache lives, or null to leave it off.
 *
 * A packaged app keeps it in the user's cache directory, which the system
 * does not back up and may empty: `~/Library/Caches` on macOS (inside the
 * container in the App Sandbox build, where home is the container and no
 * entitlement is needed), `%LOCALAPPDATA%` on Windows, `$XDG_CACHE_HOME` or
 * `~/.cache` elsewhere. Not the app's data directory, which is exported and,
 * in the sandbox build, mounted into the agents' VM.
 *
 * A dev build keeps it in its checkout's `node_modules/.cache`, so checkouts
 * do not share one.
 */
export function compileCacheBaseDir(input: {
  isPackaged: boolean
  platform: NodeJS.Platform
  home: string
  env: Record<string, string | undefined>
  /** The directory of the main entry (`dist/main`). */
  entryDir: string
}): string | null {
  if (!input.isPackaged) {
    const nodeModules = path.resolve(input.entryDir, '../../node_modules')
    if (!fs.existsSync(nodeModules)) return null
    return path.join(nodeModules, '.cache', 'electron-main-compile-cache')
  }
  if (!input.home) return null
  return path.join(userCacheRoot(input.platform, input.home, input.env), CACHE_DIR_NAME)
}

function userCacheRoot(platform: NodeJS.Platform, home: string, env: Record<string, string | undefined>): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches')
  if (platform === 'win32') return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  // The XDG spec: a relative value is invalid and ignored.
  const xdg = env.XDG_CACHE_HOME
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache')
}

/**
 * What the entry stub runs: pick the directory and turn the cache on. Returns
 * the directory in use, or null when the cache stayed off.
 */
export function startMainCompileCache(
  app: CompileCacheApp,
  entryDir: string,
  api: CompileCacheApi = nodeModule,
): string | null {
  try {
    const baseDir = compileCacheBaseDir({
      isPackaged: app.isPackaged,
      platform: process.platform,
      home: app.getPath('home'),
      env: process.env,
      entryDir,
    })
    return baseDir ? enableMainCompileCache(baseDir, api) : null
  } catch {
    return null
  }
}

/**
 * Turn the cache on for every module loaded from here on. Returns the
 * directory in use, or null when it stayed off. Never throws: a launch
 * without the cache is only slower.
 */
export function enableMainCompileCache(baseDir: string, api: CompileCacheApi = nodeModule): string | null {
  try {
    if (typeof api.enableCompileCache !== 'function') return null
    const result = api.enableCompileCache(baseDir)
    // Anything else is off (NODE_DISABLE_COMPILE_CACHE, an unwritable
    // directory) or was already on somewhere else (NODE_COMPILE_CACHE), and
    // then the directory is not ours to tidy.
    if (result.status !== api.constants?.compileCacheStatus?.ENABLED) return null
    const active = api.getCompileCacheDir?.()
    if (!active) return null
    removeOtherRuntimesCaches(baseDir, active)
    return active
  } catch {
    return null
  }
}

/**
 * Node keeps the entries in a subdirectory named for its own version and
 * V8's, so an Electron upgrade starts a new one and never reads the old one
 * again. Remove those, off the startup path and without waiting. Only ever
 * inside the cache's own directory.
 */
function removeOtherRuntimesCaches(baseDir: string, active: string): void {
  if (path.dirname(active) !== baseDir) return
  fs.readdir(baseDir, (error, names) => {
    if (error) return
    for (const name of names) {
      if (name === path.basename(active)) continue
      fs.rm(path.join(baseDir, name), { recursive: true, force: true }, () => {})
    }
  })
}
