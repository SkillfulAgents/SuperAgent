import { describe, it, expect, vi, beforeEach } from 'vitest'
import { app, ipcMain, powerMonitor } from 'electron'
import { getSettings } from '@shared/lib/config/settings'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { captureException } from '@shared/lib/error-reporting'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const semver = require('semver')

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.2.5'),
    on: vi.fn(),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
  powerMonitor: { on: vi.fn() },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ app: {} })),
}))

vi.mock('@shared/lib/services/user-settings-service', () => ({
  getUserSettings: vi.fn(() => ({ allowPrereleaseUpdates: false })),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

// `mockAutoUpdater.channel` mimics electron-updater's real setter, which
// flips `allowDowngrade=true` as a side effect. Our production code resets
// it; the mock surfaces that side effect so tests can verify the reset works.
const mockAutoUpdater: any = {
  allowPrerelease: false,
  allowDowngrade: false,
  autoDownload: false,
  autoInstallOnAppQuit: true,
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
}
let _mockChannel: string | undefined
Object.defineProperty(mockAutoUpdater, 'channel', {
  configurable: true,
  get: () => _mockChannel,
  set: (v: string | undefined) => {
    _mockChannel = v
    mockAutoUpdater.allowDowngrade = true
  },
})

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
let powerEvents: Record<string, Listener>
let appEvents: Record<string, Listener>

/** Boot the module: register IPC handlers + init auto-updater. */
async function boot() {
  handlers = {}
  events = {}
  powerEvents = {}
  appEvents = {}

  vi.mocked(ipcMain.handle).mockImplementation(((ch: string, fn: any) => {
    handlers[ch] = fn
  }) as any)

  mockAutoUpdater.on.mockImplementation((ev: string, fn: any) => {
    events[ev] = fn
    return mockAutoUpdater
  })

  vi.mocked(powerMonitor.on).mockImplementation(((ev: string, fn: any) => {
    powerEvents[ev] = fn
    return powerMonitor
  }) as any)

  vi.mocked(app.on).mockImplementation(((ev: string, fn: any) => {
    appEvents[ev] = fn
    return app
  }) as any)

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
    // Mirror electron-updater's isUpdateAvailable: an older feed version
    // counts as available iff allowDowngrade is set.
    const isNewer = semver.gt(ver, cfg.currentVersion)
    const isOlder = semver.lt(ver, cfg.currentVersion)
    if (isNewer || (mockAutoUpdater.allowDowngrade && isOlder)) {
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
    mockAutoUpdater.allowDowngrade = false
    _mockChannel = undefined
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

    // Regression: electron-updater's `channel` setter flips
    // `allowDowngrade=true`. Without our reset, the stable check inside the
    // dual-channel path would offer the older stable as an "update".
    it('does NOT offer stable as a downgrade when on a newer RC', async () => {
      setupReleases({ currentVersion: '0.3.22-rc.1', latestRC: '0.3.22-rc.1', latestStable: '0.3.21' })

      await handlers['check-for-updates']()

      expect(getStatus()).toMatchObject({ state: 'not-available' })
      // Sanity: our reset should leave allowDowngrade=false at the end.
      expect(mockAutoUpdater.allowDowngrade).toBe(false)
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

// ---------------------------------------------------------------------------
// Silent (background) check semantics
// ---------------------------------------------------------------------------

describe('silent background checks', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockAutoUpdater.allowPrerelease = false
    mockAutoUpdater.allowDowngrade = false
    _mockChannel = undefined
    vi.mocked(getSettings).mockReturnValue({ app: {} } as any)
    vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: false } as any)
    vi.mocked(app.getVersion).mockReturnValue('0.2.5')
    await boot()
  })

  it('powerMonitor resume triggers a silent check', async () => {
    setupReleases({ currentVersion: '0.2.5', latestRC: null, latestStable: '0.2.11' })

    expect(powerEvents.resume).toBeDefined()
    await powerEvents.resume?.()

    // tick() awaits runUpdateCheck which awaits the dynamic import; flush.
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(getStatus()).toMatchObject({ state: 'available', version: '0.2.11' })
  })

  it('errors during a silent check do not flip the UI to error state', async () => {
    // Manual check first so we have a known starting state.
    setupReleases({ currentVersion: '0.2.5', latestRC: null, latestStable: '0.2.5' })
    await handlers['check-for-updates']()
    expect(getStatus()).toMatchObject({ state: 'not-available' })

    // Now have the silent (resume-triggered) check throw, and have the
    // autoUpdater fire its 'error' event during that run.
    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      events['error']?.(new Error('Network blip'))
      throw new Error('Network blip')
    })

    await powerEvents.resume?.()

    // Status should not have flipped to 'error' — the user never asked for
    // this check, so noise should stay quiet.
    expect(getStatus().state).not.toBe('error')
  })

  it('errors during a manual check still surface', async () => {
    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      events['error']?.(new Error('Network down'))
      throw new Error('Network down')
    })

    await handlers['check-for-updates']()

    expect(getStatus()).toMatchObject({ state: 'error' })
  })

  it('respects autoCheckUpdates=false on resume', async () => {
    vi.mocked(getUserSettings).mockReturnValue({
      allowPrereleaseUpdates: false,
      autoCheckUpdates: false,
    } as any)
    setupReleases({ currentVersion: '0.2.5', latestRC: null, latestStable: '0.2.11' })

    await powerEvents.resume?.()

    // No check ran — status stays at the initial 'idle'.
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(getStatus()).toMatchObject({ state: 'idle' })
  })
})

// ---------------------------------------------------------------------------
// Benign "channel file not found" (latest-mac.yml 404) filtering
//
// electron-updater's checkForUpdates BOTH emits an 'error' event AND rejects,
// so the same 404 is seen twice: once in the on('error') handler and once in
// runUpdateCheckBody's catch. Neither path may report it to Sentry or flip the
// UI to 'error' — it's benign and self-heals once the mac assets finish
// uploading (ELECTRON-1N / ELECTRON-3S).
// ---------------------------------------------------------------------------

describe('channel file not found (latest-mac.yml 404)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockAutoUpdater.allowPrerelease = false
    mockAutoUpdater.allowDowngrade = false
    _mockChannel = undefined
    vi.mocked(getSettings).mockReturnValue({ app: {} } as any)
    vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: false } as any)
    vi.mocked(app.getVersion).mockReturnValue('0.2.5')
    await boot()
  })

  it('manual check: ERR_UPDATER_CHANNEL_FILE_NOT_FOUND is benign (no capture, not error)', async () => {
    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      const err: any = new Error('Cannot find latest-mac.yml in the latest release artifacts ...: HttpError: 404')
      err.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      events['error']?.(err)
      throw err
    })

    await handlers['check-for-updates']()

    expect(captureException).not.toHaveBeenCalled()
    expect(getStatus().state).not.toBe('error')
    expect(getStatus()).toMatchObject({ state: 'not-available' })
  })

  it('manual check: a 404 message without the code is still treated as benign', async () => {
    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      const err: any = new Error(
        'HttpError: 404 \n"Cannot find latest-mac.yml in the latest release artifacts (https://github.com/.../latest-mac.yml): HttpError: 404"',
      )
      err.statusCode = 404
      events['error']?.(err)
      throw err
    })

    await handlers['check-for-updates']()

    expect(captureException).not.toHaveBeenCalled()
    expect(getStatus().state).not.toBe('error')
  })

  it('silent check: a channel-file 404 stays quiet (no capture, not error)', async () => {
    setupReleases({ currentVersion: '0.2.5', latestRC: null, latestStable: '0.2.5' })
    await handlers['check-for-updates']()
    expect(getStatus()).toMatchObject({ state: 'not-available' })
    vi.mocked(captureException).mockClear()

    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      const err: any = new Error('Cannot find latest-mac.yml in the latest release artifacts ...: HttpError: 404')
      err.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
      events['error']?.(err)
      throw err
    })

    await powerEvents.resume?.()
    for (let i = 0; i < 50; i++) await Promise.resolve()

    expect(captureException).not.toHaveBeenCalled()
    expect(getStatus().state).not.toBe('error')
  })

  it('a genuine non-404 error is still captured and surfaced', async () => {
    mockAutoUpdater.checkForUpdates.mockImplementation(async () => {
      const err = new Error('Some real failure')
      events['error']?.(err)
      throw err
    })

    await handlers['check-for-updates']()

    expect(captureException).toHaveBeenCalled()
    expect(getStatus()).toMatchObject({ state: 'error' })
  })
})

// ---------------------------------------------------------------------------
// In-flight mutex (concurrent check coalescing)
// ---------------------------------------------------------------------------

describe('concurrent check coalescing', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockAutoUpdater.allowPrerelease = false
    mockAutoUpdater.allowDowngrade = false
    _mockChannel = undefined
    vi.mocked(getSettings).mockReturnValue({ app: {} } as any)
    vi.mocked(getUserSettings).mockReturnValue({ allowPrereleaseUpdates: false } as any)
    vi.mocked(app.getVersion).mockReturnValue('0.2.5')
    await boot()
  })

  // Flush queued microtasks so awaits inside runUpdateCheck (e.g. the dynamic
  // import of electron-updater) get past their suspension points.
  async function flushMicrotasks() {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  it('concurrent calls share a single in-flight check', async () => {
    let resolveCheck: (v: any) => void = () => {}
    mockAutoUpdater.checkForUpdates.mockImplementation(
      () => new Promise((resolve) => { resolveCheck = resolve as any }),
    )

    const a = handlers['check-for-updates']()
    const b = handlers['check-for-updates']()
    const c = powerEvents.resume?.() // silent

    // Wait until the first call has actually entered checkForUpdates.
    await flushMicrotasks()
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    resolveCheck({ updateInfo: { version: '0.2.11' } })
    await Promise.all([a, b, c])

    // Still only the one underlying call.
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('a manual check joining a silent in-flight check makes errors visible', async () => {
    let triggerError: () => void = () => {}
    mockAutoUpdater.checkForUpdates.mockImplementation(
      () => new Promise((_, reject) => {
        triggerError = () => {
          events['error']?.(new Error('Boom'))
          reject(new Error('Boom'))
        }
      }),
    )

    // Silent check starts first.
    const silentRun = powerEvents.resume?.()
    // Manual check joins the same in-flight promise; should promote to
    // user-visible so the error surfaces.
    const manualRun = handlers['check-for-updates']()

    // Wait for checkForUpdates to be called so triggerError is captured.
    await flushMicrotasks()
    triggerError()
    await Promise.all([silentRun, manualRun])

    expect(getStatus()).toMatchObject({ state: 'error' })
  })
})
