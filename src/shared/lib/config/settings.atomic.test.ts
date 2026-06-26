/**
 * settings.json (API keys, auth policy, skillsets, customEnvVars) must
 * be hardened against the silent data-loss bug-class:
 *   1. atomic writes (no torn settings.json),
 *   2. fail-closed reads (a corrupt file is NEVER replaced with defaults), and
 *   3. serialized fresh-read-modify-write (no lost updates; never merge onto a
 *      corruption-defaulted cache).
 *
 * Highest blast radius in the umbrella: a regression here can permanently wipe
 * every secret/auth setting on the box.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  loadSettings,
  loadSettingsStrict,
  saveSettings,
  getSettings,
  updateSettings,
  mutateSettings,
  clearSettingsCache,
  getEffectiveAnthropicApiKey,
  DEFAULT_SETTINGS,
} from './settings'
import { CorruptFileError } from '@shared/lib/utils/file-storage'

let tmpDir: string

function settingsPath(): string {
  return path.join(tmpDir, 'settings.json')
}
/** Write settings.json directly, bypassing the module (simulates external/disk state). */
function writeOnDisk(obj: unknown): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(obj))
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
  clearSettingsCache()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
  clearSettingsCache()
})

describe('saveSettings — atomic write', () => {
  it('writes valid JSON and leaves no temp file behind', () => {
    saveSettings({ ...DEFAULT_SETTINGS })
    const stray = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))
    expect(stray).toEqual([])
    expect(() => JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))).not.toThrow()
  })

  it.runIf(process.platform !== 'win32')('persists with 0o600 (owner-only) perms — holds API keys', () => {
    saveSettings({ ...DEFAULT_SETTINGS, apiKeys: { anthropicApiKey: 'sk-secret' } })
    expect(fs.statSync(settingsPath()).mode & 0o777).toBe(0o600)
  })
})

describe('loadSettings (tolerant) — never clobbers, never crashes', () => {
  it('returns defaults when the file is absent (first run)', () => {
    const s = loadSettings()
    expect(s.container.containerRunner).toBe(DEFAULT_SETTINGS.container.containerRunner)
    expect(fs.existsSync(settingsPath())).toBe(false) // did NOT create a file
  })

  it('merges a valid settings file with defaults', () => {
    writeOnDisk({ apiKeys: { anthropicApiKey: 'sk-real' }, app: { theme: 'dark' } })
    const s = loadSettings()
    expect(s.apiKeys?.anthropicApiKey).toBe('sk-real')
    expect(s.app?.theme).toBe('dark')
    // defaults still filled in
    expect(s.container.containerRunner).toBe(DEFAULT_SETTINGS.container.containerRunner)
  })

  it('on a CORRUPT file: returns defaults for display but does NOT overwrite the file', () => {
    const corrupt = '{ "apiKeys": { "anthropicApiKey": "sk-real'
    fs.writeFileSync(settingsPath(), corrupt)

    const s = loadSettings()
    // Degrades to defaults (no api key) so the app keeps working...
    expect(s.apiKeys).toBeUndefined()
    // ...but the corrupt bytes are untouched on disk — recoverable.
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(corrupt)
  })
})

describe('loadSettingsStrict — fail-closed', () => {
  it('returns defaults when absent', () => {
    expect(loadSettingsStrict().container.containerRunner).toBe(DEFAULT_SETTINGS.container.containerRunner)
  })

  it('THROWS CorruptFileError on a torn file', () => {
    fs.writeFileSync(settingsPath(), '{ "container": ')
    expect(() => loadSettingsStrict()).toThrow(CorruptFileError)
  })

  it('THROWS CorruptFileError when the file is a JSON array (not an object)', () => {
    fs.writeFileSync(settingsPath(), '[]')
    expect(() => loadSettingsStrict()).toThrow(CorruptFileError)
  })
})

describe('mutateSettings — serialized, fresh, fail-closed', () => {
  it('applies a partial update atomically and refreshes the cache', () => {
    writeOnDisk({ apiKeys: { anthropicApiKey: 'sk-real' } })
    clearSettingsCache()

    mutateSettings((s) => {
      s.app = { ...s.app, theme: 'dark' }
    })

    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
    expect(onDisk.apiKeys.anthropicApiKey).toBe('sk-real') // preserved
    expect(onDisk.app.theme).toBe('dark') // applied
    expect(getSettings().app?.theme).toBe('dark') // cache refreshed
  })

  it('re-reads FRESH from disk, ignoring a stale/poisoned cache (the headline fix)', () => {
    // 1. Real settings with an API key on disk; load into cache.
    writeOnDisk({ apiKeys: { anthropicApiKey: 'sk-real' } })
    expect(getEffectiveAnthropicApiKey()).toBe('sk-real')

    // 2. Simulate the hazard: the cache is poisoned with defaults
    //    (e.g. a transient corrupt read happened earlier), while disk is fine.
    fs.writeFileSync(settingsPath(), 'CORRUPT')
    clearSettingsCache()
    expect(loadSettings().apiKeys).toBeUndefined() // tolerant read → defaults, cache now defaults
    // Restore a good file on disk (with the key) but keep the (defaulted) cache.
    writeOnDisk({ apiKeys: { anthropicApiKey: 'sk-real' } })

    // 3. A background writer changes an UNRELATED field. The old code would have
    //    written the cached defaults, wiping the API key. mutateSettings re-reads
    //    fresh from disk → the key SURVIVES.
    mutateSettings((s) => {
      s.app = { ...s.app, theme: 'light' }
    })

    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
    expect(onDisk.apiKeys.anthropicApiKey).toBe('sk-real')
    expect(onDisk.app.theme).toBe('light')
  })

  it('sequential mutations each see the prior write (no lost updates)', () => {
    writeOnDisk({})
    for (let i = 0; i < 8; i++) {
      mutateSettings((s) => {
        s.customEnvVars = { ...(s.customEnvVars ?? {}), [`KEY_${i}`]: `v${i}` }
      })
    }
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
    expect(Object.keys(onDisk.customEnvVars).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `KEY_${i}`).sort()
    )
  })

  it('THROWS on a corrupt file and does NOT overwrite it with defaults', () => {
    const corrupt = '{ "apiKeys": { "anthropicApiKey": "sk-precious'
    fs.writeFileSync(settingsPath(), corrupt)

    expect(() => mutateSettings((s) => { s.shareAnalytics = false })).toThrow(CorruptFileError)
    // The real (corrupt-but-recoverable) bytes are intact — not replaced.
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(corrupt)
  })

  it('first-run nested mutation does NOT pollute the DEFAULT_SETTINGS constant', () => {
    // No settings.json on disk → loadSettingsStrict returns a clone of defaults.
    // A mutator that writes a NESTED field must not reach through into the shared
    // module constant (the shallow-copy bug). Capture the canonical value first.
    expect(fs.existsSync(settingsPath())).toBe(false)
    const originalRunner = DEFAULT_SETTINGS.container.containerRunner

    mutateSettings((s) => {
      s.container.containerRunner = 'a-totally-different-runner'
    })

    // The on-disk file got the new value...
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
    expect(onDisk.container.containerRunner).toBe('a-totally-different-runner')
    // ...but the module default is untouched.
    expect(DEFAULT_SETTINGS.container.containerRunner).toBe(originalRunner)
  })

  it('a settings file that OMITS skillsets cannot poison DEFAULT_SETTINGS via in-place mutation', () => {
    // settings.json exists but has no `skillsets` key → mergeLoadedSettings must
    // return a CLONE of the default array, not the shared reference. Otherwise
    // sync-remote's `current.push(config)` grows DEFAULT_SETTINGS.skillsets.
    writeOnDisk({ apiKeys: { anthropicApiKey: 'sk-real' } }) // note: no skillsets key
    const originalLen = DEFAULT_SETTINGS.skillsets!.length

    const loaded = loadSettingsStrict()
    expect(loaded.skillsets).not.toBe(DEFAULT_SETTINGS.skillsets) // distinct reference
    expect(loaded.skillsets).toEqual(DEFAULT_SETTINGS.skillsets) // same content

    // Emulate the in-place push sync-remote performs on the defaulted array.
    mutateSettings((s) => {
      const current = s.skillsets ?? []
      current.push(structuredClone(current[0]))
      s.skillsets = current
    })

    expect(DEFAULT_SETTINGS.skillsets!.length).toBe(originalLen) // module default untouched
  })
})

describe('updateSettings — atomic full replace', () => {
  it('writes atomically and updates the cache', () => {
    updateSettings({ ...DEFAULT_SETTINGS, shareAnalytics: false })
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(getSettings().shareAnalytics).toBe(false)
  })
})
