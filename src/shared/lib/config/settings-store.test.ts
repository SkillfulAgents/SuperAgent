import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  DEFAULT_SETTINGS,
  LocalFileSettingsStore,
  clearSettingsCache,
  getSettings,
  loadSettings,
  loadSettingsStrict,
  mutateSettings,
  setSettingsStore,
  updateSettings,
  type AppSettings,
} from './settings'
import type { SettingsStore } from './settings-store'
import { CorruptFileError } from '@shared/lib/utils/file-storage'

/** A store that keeps one stored document and no cache, like a remote store loaded per request. */
class InMemorySettingsStore implements SettingsStore {
  stored: AppSettings = structuredClone(DEFAULT_SETTINGS)
  corrupt = false
  clears = 0

  get(): AppSettings {
    return structuredClone(this.stored)
  }
  loadStrict(): AppSettings {
    if (this.corrupt) throw new CorruptFileError('memory', 'stored settings are corrupt')
    return structuredClone(this.stored)
  }
  save(settings: AppSettings): void {
    this.stored = structuredClone(settings)
  }
  mutate(mutator: (settings: AppSettings) => void): AppSettings {
    const fresh = this.loadStrict()
    mutator(fresh)
    this.save(fresh)
    return fresh
  }
  clearCache(): void {
    this.clears++
  }
}

let tmpDir: string
let store: InMemorySettingsStore

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-store-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
  store = new InMemorySettingsStore()
  setSettingsStore(store)
})

afterEach(() => {
  setSettingsStore(new LocalFileSettingsStore())
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.SUPERAGENT_DATA_DIR
})

describe('setSettingsStore', () => {
  it('sends reads and writes to the registered store, not settings.json', () => {
    mutateSettings((s) => {
      s.app = { ...s.app, theme: 'dark' }
    })
    expect(store.stored.app?.theme).toBe('dark')
    expect(getSettings().app?.theme).toBe('dark')

    const replaced = { ...loadSettingsStrict(), customEnvVars: { REGION: 'us-east-1' } }
    updateSettings(replaced)
    expect(store.stored.customEnvVars).toEqual({ REGION: 'us-east-1' })

    clearSettingsCache()
    expect(store.clears).toBe(1)

    expect(fs.existsSync(path.join(tmpDir, 'settings.json'))).toBe(false)
  })

  it('fails closed on corrupt stored settings for writes and degrades to defaults for reads', () => {
    store.stored.apiKeys = { anthropicApiKey: 'sk-real' }
    store.corrupt = true

    expect(() => loadSettingsStrict()).toThrow(CorruptFileError)
    expect(() => mutateSettings((s) => { s.apiKeys = {} })).toThrow(CorruptFileError)
    expect(loadSettings().apiKeys).toEqual(DEFAULT_SETTINGS.apiKeys)
    expect(store.stored.apiKeys).toEqual({ anthropicApiKey: 'sk-real' })
  })
})
