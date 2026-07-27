import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetApiTargetForTest, getActiveTarget, getTargetFallbackReason } from './api-target'
import { _resetApiBaseUrlForTest, getApiBaseUrl, initApiBaseUrl } from './env'

/**
 * Boot-time target selection: which base URL every call site in the renderer
 * ends up prefixing, and whether a stored cloud preference is honoured.
 */

const LOCAL = 'http://localhost:3000'
const CLOUD = 'http://localhost:3000/cloud/KEY123'

interface ElectronStub {
  getApiUrl?: () => Promise<string>
  getCloudApiUrl?: () => Promise<string | null>
}

/** Stub the renderer's world: Electron when `electron` is given, web when not. */
function stubWindow(options: { stored?: string; electron?: ElectronStub | null }) {
  const store = new Map<string, string>()
  if (options.stored) store.set('superagent.apiTarget', options.stored)
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
    ...(options.electron === undefined || options.electron === null
      ? {}
      : { electronAPI: options.electron }),
  })
}

const electron = (overrides: ElectronStub = {}): ElectronStub => ({
  getApiUrl: async () => LOCAL,
  getCloudApiUrl: async () => CLOUD,
  ...overrides,
})

beforeEach(() => {
  _resetApiTargetForTest()
  _resetApiBaseUrlForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
  _resetApiBaseUrlForTest()
})

describe('initApiBaseUrl', () => {
  it('uses the local API when local is the preference', async () => {
    stubWindow({ electron: electron() })
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe(LOCAL)
    expect(getActiveTarget()).toBe('local')
  })

  it('uses the keyed proxy prefix when cloud is the preference', async () => {
    stubWindow({ stored: 'cloud', electron: electron() })
    await initApiBaseUrl()

    // Every call site prefixes this, so this one value is what moves the whole
    // UI to the cloud workspace.
    expect(getApiBaseUrl()).toBe(CLOUD)
    expect(getActiveTarget()).toBe('cloud')
    expect(getTargetFallbackReason()).toBeNull()
  })

  it('falls back to local when the workspace is no longer available', async () => {
    stubWindow({ stored: 'cloud', electron: electron({ getCloudApiUrl: async () => null }) })
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe(LOCAL)
    expect(getActiveTarget()).toBe('local')
    expect(getTargetFallbackReason()).toBe('no-workspace')
  })

  it('falls back to local against a main process too old to answer', async () => {
    stubWindow({ stored: 'cloud', electron: electron({ getCloudApiUrl: undefined }) })
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe(LOCAL)
    expect(getActiveTarget()).toBe('local')
  })

  it('falls back to local when the cloud lookup itself fails', async () => {
    stubWindow({
      stored: 'cloud',
      electron: electron({ getCloudApiUrl: async () => Promise.reject(new Error('ipc down')) }),
    })
    await initApiBaseUrl()

    expect(getActiveTarget()).toBe('local')
  })

  it('is same-origin and local on the web, where there is nothing to choose', async () => {
    stubWindow({ stored: 'cloud', electron: null })
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe('')
    expect(getActiveTarget()).toBe('local')
  })

  it('settles the target even when the local lookup throws', async () => {
    stubWindow({
      electron: electron({ getApiUrl: async () => Promise.reject(new Error('ipc down')) }),
    })

    // The caller still learns it failed…
    await expect(initApiBaseUrl()).rejects.toThrow('ipc down')
    // …but the renderer can still answer "which Superagent am I?", because the
    // getters throw rather than guess.
    expect(getActiveTarget()).toBe('local')
  })
})
