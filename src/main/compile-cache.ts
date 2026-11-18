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

/** What this module uses of `node:module`; a parameter so a test can stand in for it. */
export interface CompileCacheApi {
  enableCompileCache?: (cacheDir?: string) => { status: number; directory?: string; message?: string }
  getCompileCacheDir?: () => string | undefined
  constants?: { compileCacheStatus?: { ENABLED: number } }
}

/**
 * Where the cache lives, or null to leave it off.
 *
 * A packaged app keeps it in userData, which it can always write (the App
 * Sandbox build's container included). A dev build keeps it in its checkout's
 * `node_modules/.cache`: this runs before the main bundle gives the dev app
 * its own name, so userData would still be the installed app's directory.
 */
export function compileCacheBaseDir(input: {
  isPackaged: boolean
  userData: string
  /** The directory of the main entry (`dist/main`). */
  entryDir: string
}): string | null {
  if (input.isPackaged) return path.join(input.userData, 'compile-cache')
  const nodeModules = path.resolve(input.entryDir, '../../node_modules')
  if (!fs.existsSync(nodeModules)) return null
  return path.join(nodeModules, '.cache', 'electron-main-compile-cache')
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
 * again. Remove those, off the startup path and without waiting.
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
