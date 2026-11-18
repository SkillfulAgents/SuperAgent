import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import nodeModule from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { compileCacheBaseDir, enableMainCompileCache, startMainCompileCache, type CompileCacheApi } from './compile-cache'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-cache-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const ENABLED = 1
const ALREADY_ENABLED = 2
const FAILED = 0

/** `node:module` as Node answers it: entries go in a per-runtime subdirectory. */
function fakeApi(status: number, runtime = 'v24.0.0-arm64-abc-501') {
  let active: string | undefined
  const api = {
    enableCompileCache: vi.fn((dir?: string) => {
      if (status === ENABLED && dir) {
        active = path.join(dir, runtime)
        fs.mkdirSync(active, { recursive: true })
      }
      return { status, directory: dir }
    }),
    getCompileCacheDir: () => active,
    constants: { compileCacheStatus: { ENABLED } },
  } satisfies CompileCacheApi
  return api
}

describe('compileCacheBaseDir', () => {
  const packaged = (platform: NodeJS.Platform, env: Record<string, string | undefined> = {}) =>
    compileCacheBaseDir({ isPackaged: true, platform, home: '/home/u', env, entryDir: '/app.asar/dist/main' })

  it("is in the user's cache directory on each platform for a packaged app", () => {
    expect(packaged('darwin')).toBe(path.join('/home/u', 'Library', 'Caches', 'gamut-compile-cache'))
    expect(packaged('win32', { LOCALAPPDATA: '/local' })).toBe(path.join('/local', 'gamut-compile-cache'))
    expect(packaged('win32')).toBe(path.join('/home/u', 'AppData', 'Local', 'gamut-compile-cache'))
    expect(packaged('linux', { XDG_CACHE_HOME: '/xdg' })).toBe(path.join('/xdg', 'gamut-compile-cache'))
    expect(packaged('linux', { XDG_CACHE_HOME: 'relative' })).toBe(path.join('/home/u', '.cache', 'gamut-compile-cache'))
    expect(packaged('linux')).toBe(path.join('/home/u', '.cache', 'gamut-compile-cache'))
  })

  it('follows home into the App Sandbox container, and stays out of the data directory there', () => {
    const container = '/Users/u/Library/Containers/so.gamut.app/Data'
    const dir = compileCacheBaseDir({ isPackaged: true, platform: 'darwin', home: container, env: {}, entryDir: '/x' })!
    expect(dir).toBe(path.join(container, 'Library', 'Caches', 'gamut-compile-cache'))
    expect(path.relative(path.join(container, '.superagent'), dir).startsWith('..')).toBe(true)
  })

  it('is off for a packaged app with no home', () => {
    expect(compileCacheBaseDir({ isPackaged: true, platform: 'darwin', home: '', env: {}, entryDir: '/x' })).toBeNull()
  })

  it("is in the checkout's node_modules for a dev build", () => {
    const entryDir = path.join(root, 'dist', 'main')
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    expect(compileCacheBaseDir({ isPackaged: false, platform: 'darwin', home: '/home/u', env: {}, entryDir })).toBe(
      path.join(root, 'node_modules', '.cache', 'electron-main-compile-cache'),
    )
  })

  it('is off for a dev build with no node_modules beside it', () => {
    expect(
      compileCacheBaseDir({ isPackaged: false, platform: 'darwin', home: '/home/u', env: {}, entryDir: path.join(root, 'dist', 'main') }),
    ).toBeNull()
  })
})

// Electron resolves userData and sessionData from the app's name on first
// read and keeps the answer; index.ts sets the name after the stub has run.
// A read here moves the Chromium profile and the dev data directory.
describe('the entry stub', () => {
  /** An `app` that records every path it is asked for. */
  function fakeApp(isPackaged: boolean) {
    const asked: string[] = []
    return {
      asked,
      app: {
        isPackaged,
        getPath: (name: string) => {
          asked.push(name)
          return root
        },
      },
    }
  }

  it.each([true, false])('asks Electron for no path but home (packaged: %s)', (isPackaged) => {
    const { app, asked } = fakeApp(isPackaged)
    startMainCompileCache(app, path.join(root, 'dist', 'main'), fakeApi(ENABLED))
    expect(asked.filter((name) => name !== 'home')).toEqual([])
  })

  it('turns the cache on in the cache directory of a packaged app', () => {
    const { app } = fakeApp(true)
    const api = fakeApi(ENABLED)
    startMainCompileCache(app, '/app.asar/dist/main', api)
    expect(api.enableCompileCache).toHaveBeenCalledWith(
      compileCacheBaseDir({ isPackaged: true, platform: process.platform, home: root, env: process.env, entryDir: '/x' }),
    )
  })

  it('does not throw when Electron does', () => {
    const app = {
      isPackaged: true,
      getPath: () => {
        throw new Error('no home')
      },
    }
    expect(startMainCompileCache(app, '/x', fakeApi(ENABLED))).toBeNull()
  })

  it('touches Electron only through startMainCompileCache', () => {
    const source = fs.readFileSync(path.join(__dirname, 'entry.ts'), 'utf8')
    const code = source.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/getPath|setPath|app\.name|app\.setName/)
    expect(code.match(/\bapp\b/g)).toHaveLength(2) // the import and the one argument
  })
})

describe('enableMainCompileCache', () => {
  it('turns the cache on in the directory it is given', () => {
    const api = fakeApi(ENABLED)
    expect(enableMainCompileCache(root, api)).toBe(path.join(root, 'v24.0.0-arm64-abc-501'))
    expect(api.enableCompileCache).toHaveBeenCalledWith(root)
  })

  it('removes the caches of other runtimes and keeps its own', async () => {
    const stale = path.join(root, 'v22.0.0-arm64-old-501')
    fs.mkdirSync(stale)
    fs.writeFileSync(path.join(stale, 'entry'), 'x')
    const active = enableMainCompileCache(root, fakeApi(ENABLED))!
    fs.writeFileSync(path.join(active, 'entry'), 'x')
    await vi.waitFor(() => expect(fs.existsSync(stale)).toBe(false))
    expect(fs.readdirSync(root)).toEqual([path.basename(active)])
    expect(fs.existsSync(path.join(active, 'entry'))).toBe(true)
  })

  it('leaves a directory it did not turn on alone', async () => {
    const other = path.join(root, 'other')
    fs.mkdirSync(other)
    for (const status of [ALREADY_ENABLED, FAILED]) {
      expect(enableMainCompileCache(root, fakeApi(status))).toBeNull()
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fs.existsSync(other)).toBe(true)
  })

  it('is off, without throwing, on a runtime that lacks the API or fails', () => {
    expect(enableMainCompileCache(root, {})).toBeNull()
    expect(
      enableMainCompileCache(root, {
        enableCompileCache: () => {
          throw new Error('boom')
        },
      }),
    ).toBeNull()
  })
})

// The real thing, in a child process so the test runner's own module loading
// is left alone. The cache directory is not per app version, which is only
// right if Node itself notices a file that changed: pin that here.
describe.skipIf(typeof nodeModule.enableCompileCache !== 'function')('with Node itself', () => {
  it('keeps one entry per module and recompiles a file that changed', () => {
    const cacheDir = path.join(root, 'cache')
    const dep = path.join(root, 'dep.cjs')
    const entry = path.join(root, 'entry.cjs')
    fs.writeFileSync(
      entry,
      [
        "const m = require('node:module')",
        'const r = m.enableCompileCache(process.argv[2])',
        "if (r.status !== m.constants.compileCacheStatus.ENABLED) throw new Error('not enabled: ' + r.message)",
        "process.stdout.write(require('./dep.cjs'))",
      ].join('\n'),
    )
    // Node reads either variable as set even when it is empty.
    const env = { ...process.env }
    delete env.NODE_COMPILE_CACHE
    delete env.NODE_DISABLE_COMPILE_CACHE
    const launch = () => execFileSync(process.execPath, [entry, cacheDir], { encoding: 'utf8', env })
    const entries = () =>
      fs.readdirSync(cacheDir, { recursive: true, withFileTypes: true }).filter((found) => found.isFile())

    fs.writeFileSync(dep, "module.exports = 'one'\n")
    expect(launch()).toBe('one')
    expect(entries()).toHaveLength(1)
    expect(launch()).toBe('one')

    fs.writeFileSync(dep, "module.exports = 'two'\n")
    expect(launch()).toBe('two')
    expect(entries()).toHaveLength(1)
  })
})
