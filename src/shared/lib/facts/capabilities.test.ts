import { describe, expect, it } from 'vitest'
import type { ClientFacts, ServerDistribution, ServerFacts } from './facts-schema'
import { mayDownloadCode, offersRuntime, runsInAppSandbox, runtimeCapabilities, updatesItself } from './capabilities'

const server = (distribution: ServerDistribution): ServerFacts => ({ os: 'darwin', distribution })
const desktop = (distribution: ClientFacts['distribution']): ClientFacts => ({ shell: 'electron', os: 'darwin', distribution })

describe('the Mac App Store build', () => {
  const store = server('mac-app-store')

  it('runs in the App Sandbox, asked of either half', () => {
    expect(runsInAppSandbox(store)).toBe(true)
    expect(runsInAppSandbox(desktop('mac-app-store'))).toBe(true)
  })

  it('offers only the bundled Lima, since the sandbox can’t run the other runtimes’ CLIs', () => {
    expect(offersRuntime(store, 'lima')).toBe(true)
    for (const runner of ['docker', 'podman', 'apple-container', 'wsl2', 'kubernetes', 'lambda-microvm']) {
      expect(offersRuntime(store, runner)).toBe(false)
    }
  })

  it('downloads no code it runs', () => {
    expect(mayDownloadCode(store)).toBe(false)
  })

  it('leaves its updates to the Store', () => {
    expect(updatesItself(desktop('mac-app-store'))).toBe(false)
  })

  it('declares nothing that reaches outside its container', () => {
    expect(runtimeCapabilities(store)).toEqual({
      canUseComputer: false,
      canRunHostScripts: false,
      canDriveUserChrome: false,
      canReadHostFoldersByPath: false,
      canFindHostApps: false,
      canRunHostGit: false,
    })
  })
})

// The Windows Store build is a full-trust package, so it behaves like a direct install.
describe.each(['direct', 'windows-store', 'deployment'] as const)('a %s server', (distribution) => {
  it('is not sandboxed, offers every runtime and may download code', () => {
    expect(runsInAppSandbox(server(distribution))).toBe(false)
    expect(offersRuntime(server(distribution), 'docker')).toBe(true)
    expect(mayDownloadCode(server(distribution))).toBe(true)
  })

  it('runs git and looks for installed apps on its machine', () => {
    expect(runtimeCapabilities(server(distribution))).toMatchObject({ canRunHostGit: true, canFindHostApps: true })
  })
})

describe.each(['direct', 'windows-store'] as const)('the %s desktop app', (distribution) => {
  it('declares everything that acts on the person’s computer', () => {
    expect(runtimeCapabilities({ os: 'darwin', distribution })).toEqual({
      canUseComputer: true,
      canRunHostScripts: true,
      canDriveUserChrome: true,
      canReadHostFoldersByPath: true,
      canFindHostApps: true,
      canRunHostGit: true,
    })
  })

  it('offers computer use and scripts only on macOS and Windows, the OSes with a backend', () => {
    expect(runtimeCapabilities({ os: 'win32', distribution })).toMatchObject({ canUseComputer: true, canRunHostScripts: true })
    expect(runtimeCapabilities({ os: 'linux', distribution })).toMatchObject({ canUseComputer: false, canRunHostScripts: false })
  })
})

describe('a web deployment', () => {
  it('declares no desktop-only capability, even on a Mac', () => {
    expect(runtimeCapabilities(server('deployment'))).toMatchObject({
      canUseComputer: false,
      canRunHostScripts: false,
      canDriveUserChrome: false,
      canReadHostFoldersByPath: false,
    })
  })
})

describe('updatesItself', () => {
  it('is true only for a desktop app distributed directly', () => {
    expect(updatesItself(desktop('direct'))).toBe(true)
    expect(updatesItself(desktop('windows-store'))).toBe(false)
    expect(updatesItself({ shell: 'browser', os: null, distribution: null })).toBe(false)
  })
})
