import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsElectron } = vi.hoisted(() => ({ mockIsElectron: vi.fn(() => true) }))
vi.mock('./env', () => ({ isElectron: mockIsElectron }))

import { _resetApiTargetForTest, setActiveTarget } from './api-target'
import {
  addsToDock,
  agentsRunInAppSandbox,
  appUpdatesItself,
  canUseHostFeatures,
  computerUseSupported,
  keepsMacAwake,
  listsRecentFiles,
  offersComputerUseSettings,
  offersPrivateSkillsets,
  usesHostFolderPaths,
} from './capabilities'
import { _setFactsForTest } from './facts'
import type { ServerFacts } from '@shared/lib/facts/facts-schema'

beforeEach(() => {
  mockIsElectron.mockReturnValue(true)
  _resetApiTargetForTest()
})

afterEach(() => {
  _resetApiTargetForTest()
})

describe('canUseHostFeatures', () => {
  it('is true for the desktop app driving its own machine', () => {
    setActiveTarget('local', null)
    expect(canUseHostFeatures()).toBe(true)
  })

  it('is false in cloud mode, where Electron is still present but is the wrong machine', () => {
    // The whole point of the predicate: isElectron() stays true here, so every
    // site that asked it would keep offering a directory picker, a Finder call
    // or a Docker install for a laptop that runs none of the agents.
    setActiveTarget('cloud', null)
    expect(mockIsElectron()).toBe(true)
    expect(canUseHostFeatures()).toBe(false)
  })

  it('is false in the browser', () => {
    mockIsElectron.mockReturnValue(false)
    setActiveTarget('local', null)
    expect(canUseHostFeatures()).toBe(false)
  })
})

describe('computerUseSupported', () => {
  function withServer(server: ServerFacts | null) {
    // A Linux laptop, so an answer that read the window's OS would be wrong.
    _setFactsForTest({ client: { shell: 'electron', os: 'linux', distribution: 'direct' }, server })
  }

  it.each([
    ['darwin', true],
    ['win32', true],
    ['linux', false],
    ['other', false],
  ] as const)('asks the agents’ machine: %s → %s', (os, supported) => {
    withServer({ os, distribution: 'deployment' })
    expect(computerUseSupported()).toBe(supported)
  })

  it('is false when the server didn’t say', () => {
    withServer(null)
    expect(computerUseSupported()).toBe(false)
  })
})

describe('appUpdatesItself', () => {
  it('asks this window’s app: a Store build driving a deployment still gets updates from the Store', () => {
    _setFactsForTest({
      client: { shell: 'electron', os: 'darwin', distribution: 'mac-app-store' },
      server: { os: 'linux', distribution: 'deployment' },
    })
    expect(appUpdatesItself()).toBe(false)
  })

  it('is true for a desktop app distributed directly, false in a browser', () => {
    _setFactsForTest({ client: { shell: 'electron', os: 'darwin', distribution: 'direct' }, server: null })
    expect(appUpdatesItself()).toBe(true)
    _setFactsForTest({ client: { shell: 'browser', os: null, distribution: null }, server: { os: 'linux', distribution: 'deployment' } })
    expect(appUpdatesItself()).toBe(false)
  })
})

describe('what the App Sandbox leaves out', () => {
  const store = { shell: 'electron', os: 'darwin', distribution: 'mac-app-store' } as const
  const direct = { shell: 'electron', os: 'darwin', distribution: 'direct' } as const

  function asStoreBuild() {
    setActiveTarget('local', null)
    _setFactsForTest({ client: store, server: { os: 'darwin', distribution: 'mac-app-store' } })
  }
  function asDirectBuild() {
    setActiveTarget('local', null)
    _setFactsForTest({ client: direct, server: { os: 'darwin', distribution: 'direct' } })
  }

  it('has the Store build driving its own API list it, and hide each feature', () => {
    asStoreBuild()
    expect(agentsRunInAppSandbox()).toBe(true)
    expect(offersComputerUseSettings()).toBe(false)
    expect(usesHostFolderPaths()).toBe(false)
    expect(offersPrivateSkillsets()).toBe(false)
    expect(keepsMacAwake()).toBe(false)
    expect(addsToDock()).toBe(false)
  })

  it('offers each feature in a directly distributed build', () => {
    asDirectBuild()
    expect(agentsRunInAppSandbox()).toBe(false)
    expect(offersComputerUseSettings()).toBe(true)
    expect(usesHostFolderPaths()).toBe(true)
    expect(offersPrivateSkillsets()).toBe(true)
    expect(keepsMacAwake()).toBe(true)
    expect(addsToDock()).toBe(true)
  })

  it('asks the agents’ machine for agent features: a Store build driving a deployment lists nothing', () => {
    setActiveTarget('cloud', null)
    _setFactsForTest({ client: store, server: { os: 'linux', distribution: 'deployment' } })
    expect(agentsRunInAppSandbox()).toBe(false)
    expect(offersPrivateSkillsets()).toBe(true)
  })

  it('asks this window’s app for its own Mac integrations: a Store build keeps them off on any server', () => {
    setActiveTarget('cloud', null)
    _setFactsForTest({ client: store, server: { os: 'linux', distribution: 'deployment' } })
    expect(keepsMacAwake()).toBe(false)
    expect(addsToDock()).toBe(false)
  })

  it('lists recent files only where the bridge has them and the sandbox doesn’t hide them', () => {
    vi.stubGlobal('window', { electronAPI: { getRecentFiles: () => Promise.resolve([]) } })
    try {
      _setFactsForTest({ client: direct, server: null })
      expect(listsRecentFiles()).toBe(true)
      _setFactsForTest({ client: store, server: null })
      expect(listsRecentFiles()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
