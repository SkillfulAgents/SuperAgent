import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedApiTarget } from '@shared/lib/api-target'
import {
  _resetApiTargetForTest,
  getActiveTarget,
  getRemoteDeploymentUrl,
  getTargetFallbackReason,
} from './api-target'
import { _resetApiBaseUrlForTest, getApiBaseUrl, initApiBaseUrl } from './env'
import { _resetFactsForTest, clientFacts, serverFacts } from './facts'
import type { ApiTarget } from '@shared/lib/api-target'
import type { Facts } from '@shared/lib/facts/facts-schema'

/**
 * Boot-time target selection: which base URL every call site in the renderer
 * ends up prefixing. Main settles the answer; this checks the renderer adopts
 * it, and degrades safely when it cannot be had.
 */

const LOCAL = 'http://localhost:3000'
const CLOUD = 'http://localhost:3000/cloud/KEY123'
const DEPLOYMENT = 'https://acme.gamut.example'

interface ElectronStub {
  getApiUrl?: () => Promise<string>
  getApiTarget?: () => Promise<ResolvedApiTarget>
  getFacts?: (target: ApiTarget) => Promise<Facts>
  platform?: string
}

/** Stub the renderer's world: Electron when `electron` is given, web when not. */
function stubWindow(electron?: ElectronStub | null) {
  vi.stubGlobal('window', electron == null ? {} : { electronAPI: electron })
}

const electron = (overrides: ElectronStub = {}): ElectronStub => ({
  getApiUrl: async () => LOCAL,
  getApiTarget: async () => ({ target: 'local', baseUrl: LOCAL, deploymentUrl: null, fallback: null }),
  ...overrides,
})

beforeEach(() => {
  _resetApiTargetForTest()
  _resetApiBaseUrlForTest()
  _resetFactsForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
  _resetApiBaseUrlForTest()
})

describe('initApiBaseUrl', () => {
  it('uses the local API when main resolves to local', async () => {
    stubWindow(electron())
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe(LOCAL)
    expect(getActiveTarget()).toBe('local')
  })

  it('uses the keyed proxy prefix when main resolves to cloud', async () => {
    stubWindow(
      electron({
        getApiTarget: async () => ({
          target: 'cloud',
          baseUrl: CLOUD,
          deploymentUrl: DEPLOYMENT,
          fallback: null,
        }),
      }),
    )
    await initApiBaseUrl()

    // Every call site prefixes this, so this one value is what moves the whole
    // UI to the cloud workspace.
    expect(getApiBaseUrl()).toBe(CLOUD)
    expect(getActiveTarget()).toBe('cloud')
    expect(getTargetFallbackReason()).toBeNull()
    // Where to send the user in a browser — never a request base.
    expect(getRemoteDeploymentUrl()).toBe(DEPLOYMENT)
  })

  it('carries the reason main denied a stored cloud preference', async () => {
    stubWindow(
      electron({
        getApiTarget: async () => ({
          target: 'local',
          baseUrl: LOCAL,
          deploymentUrl: null,
          fallback: 'no-workspace',
        }),
      }),
    )
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe(LOCAL)
    expect(getActiveTarget()).toBe('local')
    expect(getTargetFallbackReason()).toBe('no-workspace')
  })

  it('falls back to local against a main process too old to answer', async () => {
    stubWindow(electron({ getApiTarget: undefined }))
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe(LOCAL)
    expect(getActiveTarget()).toBe('local')
  })

  it('falls back to local when the target lookup itself fails', async () => {
    stubWindow(electron({ getApiTarget: async () => Promise.reject(new Error('ipc down')) }))
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe(LOCAL)
    expect(getActiveTarget()).toBe('local')
  })

  it('is same-origin and local on the web, where there is nothing to choose', async () => {
    stubWindow(null)
    await initApiBaseUrl()

    expect(getApiBaseUrl()).toBe('')
    expect(getActiveTarget()).toBe('local')
  })

  it('settles the target even when every lookup throws', async () => {
    stubWindow(
      electron({
        getApiTarget: async () => Promise.reject(new Error('ipc down')),
        getApiUrl: async () => Promise.reject(new Error('ipc down')),
      }),
    )

    // The caller still learns it failed…
    await expect(initApiBaseUrl()).rejects.toThrow('ipc down')
    // …but the renderer can still answer "which Superagent am I?", because the
    // getters throw rather than guess.
    expect(getActiveTarget()).toBe('local')
    // The facts are settled too, so the first render can read them.
    expect(clientFacts().shell).toBe('electron')
  })
})

describe('initApiBaseUrl settles the facts', () => {
  const cloudFacts: Facts = {
    client: { shell: 'electron', os: 'darwin', distribution: 'mac-app-store' },
    server: { os: 'linux', distribution: 'deployment' },
  }

  it('asks main for the facts of the target it settled', async () => {
    const getFacts = vi.fn(async () => cloudFacts)
    stubWindow(
      electron({
        getApiTarget: async () => ({ target: 'cloud', baseUrl: CLOUD, deploymentUrl: DEPLOYMENT, fallback: null }),
        getFacts,
      }),
    )
    await initApiBaseUrl()

    expect(getFacts).toHaveBeenCalledWith('cloud')
    expect(clientFacts()).toEqual(cloudFacts.client)
    expect(serverFacts()).toEqual(cloudFacts.server)
  })

  it('asks for local facts when main denied a stored cloud preference', async () => {
    const getFacts = vi.fn(async () => cloudFacts)
    stubWindow(
      electron({
        getApiTarget: async () => ({ target: 'local', baseUrl: LOCAL, deploymentUrl: null, fallback: 'no-workspace' }),
        getFacts,
      }),
    )
    await initApiBaseUrl()

    expect(getFacts).toHaveBeenCalledWith('local')
  })
})
