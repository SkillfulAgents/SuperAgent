import { BrowserWindow, ipcMain, app, powerMonitor } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { captureException } from '@shared/lib/error-reporting'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }
let mainWindowRef: BrowserWindow | null = null
let updaterReady = false
let suppressErrors = false
let scheduledCheckTimer: NodeJS.Timeout | null = null
let initialCheckTimer: NodeJS.Timeout | null = null

// Coalesces concurrent calls to runUpdateCheck so the dual-channel prerelease
// path can't have its `autoUpdater.channel` mutations interleave.
let runningCheck: Promise<void> | null = null
// True if any caller of the in-flight check wants errors surfaced to the UI.
// Background ticks pass silent=true; manual checks pass silent=false. If a
// manual check joins an in-flight silent check, this flips on so errors show.
let runIsUserVisible = false

// Run an automatic check ~30s after init (let the app settle first), then every 4h.
const INITIAL_CHECK_DELAY_MS = 30_000
const RECURRING_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

async function getAutoUpdater() {
  const mod = await import('electron-updater')
  return mod.autoUpdater ?? (mod as any).default?.autoUpdater
}

function semverGt(a: string, b: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('semver').gt(a, b)
}

function sendStatusToRenderer() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('update-status', currentStatus)
  }
}

function setStatus(status: UpdateStatus) {
  currentStatus = status
  sendStatusToRenderer()
}

/**
 * Core update-check routine, shared by manual IPC checks and the scheduled
 * background checks. When `silent` is true, errors and the dev-mode-not-ready
 * state are not surfaced to the UI. Concurrent callers coalesce into a single
 * in-flight check; if any caller is non-silent, that check becomes user-visible.
 */
async function runUpdateCheck({ silent }: { silent: boolean }): Promise<void> {
  if (runningCheck) {
    if (!silent) runIsUserVisible = true
    return runningCheck
  }
  runIsUserVisible = !silent
  runningCheck = (async () => {
    try {
      await runUpdateCheckBody()
    } finally {
      runningCheck = null
    }
  })()
  return runningCheck
}

async function runUpdateCheckBody() {
  if (!updaterReady) {
    if (runIsUserVisible) {
      setStatus({ state: 'error', error: 'Auto-update is not available in development mode' })
    }
    return
  }
  try {
    const autoUpdater = await getAutoUpdater()
    const isPreRelease = app.getVersion().includes('-')
    const wantPrerelease = !!getUserSettings('local').allowPrereleaseUpdates

    autoUpdater.allowPrerelease = wantPrerelease
    // electron-updater's `channel` setter has a side effect: it flips
    // `allowDowngrade=true`. We mutate channel below in the dual-channel path,
    // and the singleton state survives between checks. Reset defensively here
    // so we never offer a downgrade (e.g. user on 0.3.22-rc.1 being offered
    // the older 0.3.21 stable).
    autoUpdater.allowDowngrade = false

    if (!isPreRelease || !wantPrerelease) {
      // Stable user: electron-updater handles this correctly.
      //   wantPrerelease=false → latest stable
      //   wantPrerelease=true  → absolute latest (feed order = newest first)
      await autoUpdater.checkForUpdates()
      return
    }

    // Pre-release user: electron-updater only matches releases on the same
    // prerelease channel (e.g. "rc"), so it misses newer stable releases.
    // Check both channels and offer whichever version is highest.

    // Derive the prerelease channel from the current version (e.g. "rc" from "0.3.0-rc.1").
    // We must set it explicitly because autoUpdater.channel can be null when never set,
    // and assigning null back after changing it corrupts the internal state.
    const preChannel = app.getVersion().match(/-([a-zA-Z]+)/)?.[1] ?? 'rc'

    // 1. Check prerelease channel
    let preVer: string | null = null
    try {
      autoUpdater.allowPrerelease = true
      autoUpdater.channel = preChannel
      autoUpdater.allowDowngrade = false  // channel setter just flipped this on
      const result = await autoUpdater.checkForUpdates()
      preVer = result?.updateInfo?.version ?? null
    } catch {
      // prerelease check failed — will try stable below
    }

    // 2. Check stable channel
    let stableVer: string | null = null
    try {
      suppressErrors = true
      autoUpdater.allowPrerelease = false
      autoUpdater.channel = 'latest'
      autoUpdater.allowDowngrade = false  // channel setter just flipped this on
      const result: any = await Promise.race([
        autoUpdater.checkForUpdates(),
        new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
      ])
      stableVer = result?.updateInfo?.version ?? null
    } catch {
      // stable check failed or timed out
    } finally {
      suppressErrors = false
    }

    // 3. Pick the higher version. The last checkForUpdates() call determines
    //    what downloadUpdate() will fetch, so re-run the prerelease check if
    //    the prerelease version wins (stable was the last call above).
    if (preVer && (!stableVer || semverGt(preVer, stableVer))) {
      autoUpdater.allowPrerelease = true
      autoUpdater.channel = preChannel
      autoUpdater.allowDowngrade = false  // channel setter just flipped this on
      await autoUpdater.checkForUpdates()
    }

    // If neither check found anything newer, make sure UI reflects that
    if (!preVer && !stableVer) {
      setStatus({ state: 'not-available' })
    }
  } catch (err) {
    captureException(err, {
      tags: { component: 'auto-updater', operation: 'check' },
      extra: { currentVersion: app.getVersion(), userVisible: runIsUserVisible },
    })
    if (runIsUserVisible) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus({ state: 'error', error: message })
    }
  }
}

function scheduleAutomaticUpdateChecks() {
  if (scheduledCheckTimer) return

  const tick = async () => {
    // Re-read setting each tick so toggling it takes effect on the next interval.
    const autoCheck = getUserSettings('local').autoCheckUpdates
    if (autoCheck === false) return
    await runUpdateCheck({ silent: true })
  }

  initialCheckTimer = setTimeout(tick, INITIAL_CHECK_DELAY_MS)
  scheduledCheckTimer = setInterval(tick, RECURRING_CHECK_INTERVAL_MS)

  // setInterval is suspended during macOS sleep; on resume we may have skipped
  // multiple ticks. Run an immediate check to catch up. `tick` is async but
  // electron's typings accept `() => void`; the assignment is sound because
  // tick swallows its own errors via runUpdateCheck's catch.
  powerMonitor.on('resume', tick)

  app.on('before-quit', () => {
    if (initialCheckTimer) clearTimeout(initialCheckTimer)
    if (scheduledCheckTimer) clearInterval(scheduledCheckTimer)
    initialCheckTimer = null
    scheduledCheckTimer = null
  })
}

/**
 * Register IPC handlers for auto-update. Call this unconditionally
 * so the renderer never gets "no handler registered" errors.
 */
export function registerUpdateHandlers() {
  ipcMain.handle('get-update-status', () => {
    return currentStatus
  })

  ipcMain.handle('check-for-updates', async () => {
    await runUpdateCheck({ silent: false })
  })

  ipcMain.handle('download-update', async () => {
    if (!updaterReady) return
    try {
      const autoUpdater = await getAutoUpdater()
      await autoUpdater.downloadUpdate()
    } catch (err) {
      captureException(err, {
        tags: { component: 'auto-updater', operation: 'download' },
        extra: { currentVersion: app.getVersion(), targetVersion: currentStatus.version },
      })
      const message = err instanceof Error ? err.message : String(err)
      setStatus({ state: 'error', error: message })
    }
  })

  ipcMain.handle('install-update', async () => {
    if (!updaterReady) return
    const autoUpdater = await getAutoUpdater()
    autoUpdater.quitAndInstall()
  })
}

/**
 * Initialize the actual electron-updater. Only call in production builds.
 */
export async function initAutoUpdater(mainWindow: BrowserWindow) {
  mainWindowRef = mainWindow

  try {
    const autoUpdater = await getAutoUpdater()
    if (!autoUpdater) {
      console.warn('electron-updater: autoUpdater not found, skipping auto-update init')
      return
    }

    // Dev-only escape hatch: pretend we're an older version so the GitHub feed
    // returns "update available". Activated by SUPERAGENT_TEST_UPDATES=1.
    // SUPERAGENT_FAKE_VERSION overrides the reported version (default 0.0.1).
    // Gated on !app.isPackaged so a stray env var on a shipped build can't
    // redirect the auto-updater feed.
    if (process.env.SUPERAGENT_TEST_UPDATES === '1' && !app.isPackaged) {
      const fakeVersion = process.env.SUPERAGENT_FAKE_VERSION || '0.0.1'
      const cfgPath = path.join(os.tmpdir(), 'superagent-dev-app-update.yml')
      fs.writeFileSync(
        cfgPath,
        'provider: github\nowner: SkillfulAgents\nrepo: SuperAgent\n',
      )
      autoUpdater.updateConfigPath = cfgPath
      autoUpdater.forceDevUpdateConfig = true
      // electron-updater exposes `currentVersion` as a writable setter at
      // runtime, but the type declares it readonly — cast to bypass the check.
      ;(autoUpdater as any).currentVersion = fakeVersion
      console.log(`[auto-updater] TEST MODE: pretending to be v${fakeVersion}, feed=${cfgPath}`)
    }

    // Don't auto-download — let the user choose
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = !!getUserSettings('local').allowPrereleaseUpdates

    autoUpdater.on('checking-for-update', () => {
      setStatus({ state: 'checking' })
    })

    autoUpdater.on('update-available', (info: any) => {
      setStatus({ state: 'available', version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
      setStatus({ state: 'not-available' })
    })

    autoUpdater.on('download-progress', (progress: any) => {
      setStatus({ state: 'downloading', progress: progress.percent })
    })

    autoUpdater.on('update-downloaded', (info: any) => {
      setStatus({ state: 'downloaded', version: info.version })
    })

    autoUpdater.on('error', (err: Error) => {
      if (suppressErrors) return
      const isTransientNetworkError = /net::ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_TIMED_OUT|CONNECTION_REFUSED|CONNECTION_RESET)\b/.test(err.message)
      if (!isTransientNetworkError) {
        captureException(err, {
          tags: { component: 'auto-updater', operation: 'runtime' },
          extra: {
            currentVersion: app.getVersion(),
            state: currentStatus.state,
            userVisible: runIsUserVisible,
          },
          level: 'warning',
        })
      }
      // Errors during a purely silent background check should not flip the UI
      // to error state — the user never asked for the check.
      if (runningCheck && !runIsUserVisible) return
      setStatus({ state: 'error', error: err.message })
    })

    updaterReady = true
    scheduleAutomaticUpdateChecks()
  } catch (err) {
    captureException(err, {
      tags: { component: 'auto-updater', operation: 'init' },
      level: 'warning',
    })
    console.warn('Failed to initialize auto-updater:', err)
  }
}

export function updateAutoUpdaterWindow(window: BrowserWindow | null) {
  mainWindowRef = window
}
