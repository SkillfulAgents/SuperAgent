import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryFileOps } from '@shared/lib/agent-actor/testing/in-memory-file-ops'
import { ChromeProfileAccessError } from './chrome-profile'
import { BROWSER_PROFILE_DIR, seedBrowserProfileFromChrome } from './seed-browser-profile'

const settingsState: { chromeProfileId?: string; hostBrowserProvider?: string } = {}
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: { ...settingsState } }),
}))

const copyChromeProfileData = vi.fn()
vi.mock('./chrome-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chrome-profile')>(),
  copyChromeProfileData: (...args: unknown[]) => copyChromeProfileData(...args),
}))

describe('seedBrowserProfileFromChrome', () => {
  beforeEach(() => {
    copyChromeProfileData.mockReset()
    copyChromeProfileData.mockResolvedValue(true)
    settingsState.chromeProfileId = undefined
    settingsState.hostBrowserProvider = undefined
  })

  it('syncs the selected profile into the workspace through its file operations', async () => {
    settingsState.chromeProfileId = 'Default'
    const files = new InMemoryFileOps()
    await seedBrowserProfileFromChrome('a', files)

    expect(copyChromeProfileData).toHaveBeenCalledTimes(1)
    const [profileId, destination] = copyChromeProfileData.mock.calls[0] as [string, { writeManifest(text: string): Promise<void> }]
    expect(profileId).toBe('Default')
    // The destination writes into the workspace, under the browser profile directory.
    await destination.writeManifest('{"probe":true}')
    expect(Object.keys(files.snapshot())).toEqual([`${BROWSER_PROFILE_DIR}/.superagent-profile-sync.json`])
  })

  it('does nothing without a selected profile', async () => {
    await seedBrowserProfileFromChrome('a', new InMemoryFileOps())
    expect(copyChromeProfileData).not.toHaveBeenCalled()
  })

  it('starts without the profile when this app may not read it', async () => {
    settingsState.chromeProfileId = 'Default'
    copyChromeProfileData.mockRejectedValue(new ChromeProfileAccessError('Default', {
      cause: Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(seedBrowserProfileFromChrome('a', new InMemoryFileOps())).resolves.toBeUndefined()
  })

  it('fails the start on any other failure', async () => {
    settingsState.chromeProfileId = 'Default'
    const failure = new Error('disk full')
    copyChromeProfileData.mockRejectedValue(failure)

    await expect(seedBrowserProfileFromChrome('a', new InMemoryFileOps())).rejects.toBe(failure)
  })

  it('does not copy a local profile into a workspace that uses the host browser', async () => {
    settingsState.chromeProfileId = 'Default'
    settingsState.hostBrowserProvider = 'chrome'
    await seedBrowserProfileFromChrome('a', new InMemoryFileOps())
    expect(copyChromeProfileData).not.toHaveBeenCalled()
  })
})
