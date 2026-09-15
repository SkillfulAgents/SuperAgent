import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryFileOps } from '@shared/lib/agent-actor/testing/in-memory-file-ops'
import { BROWSER_PROFILE_DIR, seedBrowserProfileFromChrome } from './seed-browser-profile'

const settingsState: { chromeProfileId?: string; hostBrowserProvider?: string } = {}
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: { ...settingsState } }),
}))

const copyChromeProfileData = vi.fn()
vi.mock('./chrome-profile', () => ({
  PROFILE_SYNC_MANIFEST: '.superagent-profile-sync.json',
  copyChromeProfileData: (...args: unknown[]) => copyChromeProfileData(...args),
}))

describe('seedBrowserProfileFromChrome', () => {
  beforeEach(() => {
    copyChromeProfileData.mockReset()
    copyChromeProfileData.mockResolvedValue(true)
    settingsState.chromeProfileId = undefined
    settingsState.hostBrowserProvider = undefined
  })

  it('syncs the selected profile into the workspace through the actor', async () => {
    settingsState.chromeProfileId = 'Default'
    const files = new InMemoryFileOps()
    await seedBrowserProfileFromChrome({ slug: 'a', files })

    expect(copyChromeProfileData).toHaveBeenCalledTimes(1)
    const [profileId, destination] = copyChromeProfileData.mock.calls[0] as [string, { writeManifest(text: string): Promise<void> }]
    expect(profileId).toBe('Default')
    // The destination writes into the workspace, under the browser profile directory.
    await destination.writeManifest('{"probe":true}')
    expect(Object.keys(files.snapshot())).toEqual([`${BROWSER_PROFILE_DIR}/.superagent-profile-sync.json`])
  })

  it('does nothing without a selected profile', async () => {
    await seedBrowserProfileFromChrome({ slug: 'a', files: new InMemoryFileOps() })
    expect(copyChromeProfileData).not.toHaveBeenCalled()
  })

  it('does not copy a local profile into a workspace that uses the host browser', async () => {
    settingsState.chromeProfileId = 'Default'
    settingsState.hostBrowserProvider = 'chrome'
    await seedBrowserProfileFromChrome({ slug: 'a', files: new InMemoryFileOps() })
    expect(copyChromeProfileData).not.toHaveBeenCalled()
  })
})
