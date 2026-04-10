import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app, ipcMain } from 'electron'
import { getSettings } from '@shared/lib/config/settings'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const semver = require('semver')

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.2.5') },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ app: {} })),
}))

vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: vi.fn(() => ({ allowPrereleaseUpdates: false })),
}))

const mockAutoUpdater = {
  allowPrerelease: false,
  channel: undefined as string | undefined,
  autoDownload: false,
  autoInstallOnAppQuit: true,
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
}

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (...args: any[]) => any
type Listener = (...args: any[]) => void

let handlers: Record<string, Handler>
let events: Record<string, Listener>

/** Boot the module: register IPC handlers + init auto-updater. */
async function boot() {
  handlers = {}
  events = {}

  vi.mocked(ipcMain.handle).mockImplementation(((ch: string, fn: any) => {
    handlers[ch] = fn
  }) as any)

  mockAutoUpdater.on.mockImplementation((ev: string, fn: any) => {
    events[ev] = fn
    return mockAutoUpdater
  })

  // resetModules so the module-level state (currentStatus, updaterReady, etc.)
  // starts fresh for every test.
  vi.resetModules()
  const mod = await import('./auto-updater')
  mod.registerUpdateHandlers()
  await mod.initAutoUpdater({
    isDestroyed: () => true,
    webContents: { send: vi.fn() },
  } as any)
}

/**
 * Simulate electron-updater's GitHub provider behaviour.
 *
 * When `allowPrerelease = true` the mock returns the latest RC version (which
 * mirrors the real provider's channel-matching logic for users on an RC).
 * When `allowPrerelease = false` it returns the latest stable version.
 */
function setupReleases(cfg: {
  currentVersion: string
  latestRC: string | null
  latestStable: string | null
}) {
  vi.mocked(app.getVersion).mockReturnValue(cfg.currentVersion)

  mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
    const ver = mockAutoUpdater.allowPrerelease ? cfg.latestRC : cfg.latestStable
    if (!ver) throw new Error('No releases found')

    events['checking-for-update']?.()
    if (semver.gt(ver, cfg.currentVersion)) {
      events['update-available']?.({ version: ver })
    } else {
      events['update-not-available']?.()
    }
    return { updateInfo: { version: ver } }
  })
}

function getStatus() {
  return handlers['get-update-status']()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('check-for-updates', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockAutoUpdater.allowPrerelease = false
    mockAutoUpdater.channel = undefined
    vi.mocked(getSettings).mockReturnValue({ app: {} } as any)
    vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: false } as any)
    vi.mocked(app.getVersion).mockReturnValue('0.2.5')
    await boot()
  })

  // ---- Stable user ----------------------------------------------------------

  describe('stable user', () => {
    it('prereleases off → latest stable', async () => {
      setupReleases({ currentVersion: '0.2.5', latestRC: '0.2.9-rc.2', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.11' })
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    it('prereleases on → single check with allowPrerelease=true', async () => {
      vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: true } as any)
      setupReleases({ currentVersion: '0.2.5', latestRC: '0.2.12-rc.1', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      // Stable user takes the single-check fast path; electron-updater picks the
      // absolute latest from the feed when allowPrerelease is true.
      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.12-rc.1' })
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    })

    it('already on latest → not-available', async () => {
      setupReleases({ currentVersion: '0.2.11', latestRC: '0.2.9-rc.2', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'not-available' })
    })
  })

  // ---- RC user (the core fix) -----------------------------------------------

  describe('RC user (prereleases off)', () => {
    it('gets stable only, ignoring newer RC', async () => {
      setupReleases({ currentVersion: '0.3.2-rc.1', latestRC: '0.3.4-rc.1', latestStable: '0.3.3' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'available', version: '0.3.3' })
      // Single check — stable-only fast path
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(mockAutoUpdater.allowPrerelease).toBe(false)
    })

    it('already on RC newer than stable → not-available', async () => {
      setupReleases({ currentVersion: '0.3.4-rc.1', latestRC: '0.3.4-rc.1', latestStable: '0.3.3' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'not-available' })
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  describe('RC user (prereleases on)', () => {
    beforeEach(() => {
      vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: true } as any)
    })

    it('gets stable when stable > latest RC', async () => {
      setupReleases({ currentVersion: '0.2.8-rc.1', latestRC: '0.2.9-rc.2', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.11' })
      // prerelease check + stable check (stable wins, no re-run needed)
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    })

    it('gets RC when RC > stable', async () => {
      setupReleases({ currentVersion: '0.2.8-rc.1', latestRC: '0.2.12-rc.1', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.12-rc.1' })
      // prerelease + stable + prerelease re-run (to set correct download target)
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
    })

    it('already on latest RC, stable newer → gets stable', async () => {
      setupReleases({ currentVersion: '0.2.9-rc.2', latestRC: '0.2.9-rc.2', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.11' })
    })

    it('already on latest of everything → not-available', async () => {
      setupReleases({ currentVersion: '0.2.12-rc.1', latestRC: '0.2.12-rc.1', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'not-available' })
    })
  })

  // ---- Error handling -------------------------------------------------------

  describe('error handling', () => {
    it('RC user: prerelease check fails → falls back to stable', async () => {
      vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: true } as any)
      vi.mocked(app.getVersion).mockReturnValue('0.2.8-rc.1')

      let callIdx = 0
      mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
        callIdx++
        if (callIdx === 1) throw new Error('Network error') // prerelease fails
        // stable succeeds
        events['checking-for-update']?.()
        events['update-available']?.({ version: '0.2.11' })
        return { updateInfo: { version: '0.2.11' } }
      })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.11' })
    })

    it('RC user: stable check fails → keeps prerelease result', async () => {
      vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: true } as any)
      vi.mocked(app.getVersion).mockReturnValue('0.2.8-rc.1')

      let callIdx = 0
      mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
        callIdx++
        if (callIdx === 2) throw new Error('Network error') // stable fails
        // prerelease + re-run succeed
        events['checking-for-update']?.()
        events['update-available']?.({ version: '0.2.9-rc.2' })
        return { updateInfo: { version: '0.2.9-rc.2' } }
      })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.9-rc.2' })
      // prerelease + failed stable + prerelease re-run
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3)
    })

    it('RC user: both checks fail → not-available', async () => {
      vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: true } as any)
      vi.mocked(app.getVersion).mockReturnValue('0.2.8-rc.1')
      mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('Network error'))

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'not-available' })
    })
  })

  // ---- Channel management ----------------------------------------------------

  describe('channel management', () => {
    beforeEach(() => {
      vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: true } as any)
    })

    it('sets channel to prerelease channel derived from version', async () => {
      setupReleases({ currentVersion: '0.2.8-rc.1', latestRC: '0.2.12-rc.1', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      // prerelease wins → channel should be set to "rc" (derived from version)
      expect(mockAutoUpdater.channel).toBe('rc')
    })

    it('sets channel to latest when stable wins', async () => {
      setupReleases({ currentVersion: '0.2.8-rc.1', latestRC: '0.2.9-rc.2', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      // stable wins → channel stays as "latest" from the stable check
      expect(mockAutoUpdater.channel).toBe('latest')
    })

    it('derives channel from beta prerelease tag', async () => {
      setupReleases({ currentVersion: '0.3.0-beta.1', latestRC: '0.3.0-beta.2', latestStable: '0.2.11' })

      await handlers['check-for-updates']()

      expect(mockAutoUpdater.channel).toBe('beta')
    })

    it('derives channel from alpha prerelease tag', async () => {
      setupReleases({ currentVersion: '1.0.0-alpha.3', latestRC: '1.0.0-alpha.5', latestStable: '0.9.0' })

      await handlers['check-for-updates']()

      expect(mockAutoUpdater.channel).toBe('alpha')
    })

    it('channel is never null after RC user check', async () => {
      setupReleases({ currentVersion: '0.3.0-rc.1', latestRC: '0.3.0-rc.6', latestStable: '0.2.12' })

      await handlers['check-for-updates']()

      expect(mockAutoUpdater.channel).not.toBeNull()
      expect(mockAutoUpdater.channel).not.toBeUndefined()
      expect(typeof mockAutoUpdater.channel).toBe('string')
    })
  })

  // ---- Consecutive checks (regression for null channel bug) -----------------

  describe('consecutive checks', () => {
    beforeEach(() => {
      vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: true } as any)
    })

    it('RC user: second check works after first (no null channel)', async () => {
      setupReleases({ currentVersion: '0.3.0-rc.1', latestRC: '0.3.0-rc.6', latestStable: '0.2.12' })

      await handlers['check-for-updates']()
      expect(getStatus()).toMatchObject({ state: 'available', version: '0.3.0-rc.6' })

      // Reset call count but keep the same mock behavior
      mockAutoUpdater.checkForUpdates.mockClear()

      await handlers['check-for-updates']()
      // Second check should also find the RC, not fall back to stable
      expect(getStatus()).toMatchObject({ state: 'available', version: '0.3.0-rc.6' })
    })

    it('RC user: second check finds correct version even when stable wins', async () => {
      setupReleases({ currentVersion: '0.2.8-rc.1', latestRC: '0.2.9-rc.2', latestStable: '0.2.11' })

      await handlers['check-for-updates']()
      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.11' })

      mockAutoUpdater.checkForUpdates.mockClear()

      await handlers['check-for-updates']()
      expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.11' })
      // prerelease check + stable check (stable wins)
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2)
    })

    it('RC user: three consecutive checks all succeed', async () => {
      setupReleases({ currentVersion: '0.3.0-rc.1', latestRC: '0.3.0-rc.6', latestStable: '0.2.12' })

      for (let i = 0; i < 3; i++) {
        mockAutoUpdater.checkForUpdates.mockClear()
        await handlers['check-for-updates']()
        expect(getStatus()).toMatchObject({ state: 'available', version: '0.3.0-rc.6' })
      }
    })
  })
})
