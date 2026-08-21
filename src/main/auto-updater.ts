import { BrowserWindow, ipcMain, app, powerMonitor } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'

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

// Hard ceiling on a single check. electron-updater can hang silently — no
// 'error' event, no resolution — on flaky networks (e.g. a check fired right
// after macOS wakes from sleep, before wifi reconnects). The 'checking-for-update'
// event has already painted the UI to 'checking' (a disabled spinner) by then, so
// without this backstop the button sticks there forever. 25s is well past a
// healthy check (~1-3s) but short enough not to strand the user.
const CHECK_TIMEOUT_MS = 25_000

async function getAutoUpdater() {
  const mod = await import('electron-updater')
  return mod.autoUpdater ?? (mod as any).default?.autoUpdater
}

function semverGt(a: string, b: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('semver').gt(a, b)
}

/**
 * True for the benign "channel file (latest-mac.yml) is missing" failure.
 *
 * This happens when the newest release on the feed has no mac artifacts yet —
 * e.g. a stable user with allowPrereleaseUpdates picks the newest rc whose
 * release published before its mac assets (latest-mac.yml) finished uploading,
 * or a stable release seen mid-publish. electron-updater surfaces it as
 * ERR_UPDATER_CHANNEL_FILE_NOT_FOUND / an HTTP 404 on latest-mac.yml. There's
 * nothing the user can do and it self-heals once the assets land, so we treat
 * it as "no update available" rather than reporting it to Sentry.
 */
function isChannelFileNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return true
  const statusCode = (err as { statusCode?: unknown }).statusCode
  if (statusCode === 404) return true
  const message = err instanceof Error ? err.message : String(err)
  return /Cannot find .*latest-mac\.yml.*404/.test(message)
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

// Shown on a manual check when the channel file is missing (latest-mac.yml 404).
// A user who actively asked deserves an honest "couldn't verify, retry" rather
// than a false "you're up to date" — there may be a newer release mid-publish.
const CHANNEL_FILE_PENDING_MESSAGE =
  'Could not check for updates right now — the latest release may still be publishing. Please try again shortly.'

/**
 * Apply the benign channel-file-404 status. A silent background check stays
 * quiet at 'not-available'; a user-initiated check gets the honest, non-Sentry
 * "try again shortly" message instead of a misleading "no update available".
 */
function setChannelFilePendingStatus() {
  if (runIsUserVisible) {
    setStatus({ state: 'error', error: CHANNEL_FILE_PENDING_MESSAGE })
  } else {
    setStatus({ state: 'not-available' })
  }
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
    let watchdog: NodeJS.Timeout | undefined
    try {
      // runUpdateCheckBody handles its own errors internally, so the only thing
      // that rejects the race is the watchdog — i.e. a genuine hang where the
      // updater never fired a terminal event. Reset the stuck 'checking' UI then.
      await Promise.race([
        runUpdateCheckBody(),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error('Timed out checking for updates')),
            CHECK_TIMEOUT_MS,
          )
        }),
      ])
    } catch (err) {
      // Only clobber if we're still stuck on 'checking'; if the body already
      // landed a terminal state the race resolved and we never get here.
      if (currentStatus.state === 'checking') {
        if (runIsUserVisible) {
          const message = err instanceof Error ? err.message : String(err)
          setStatus({ state: 'error', error: message })
        } else {
          setStatus({ state: 'idle' })
        }
      }
    } finally {
      if (watchdog) clearTimeout(watchdog)
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
    const wantPrerelease = !!getUserSettings('local').allowPrereleaseUpdates

    autoUpdater.allowPrerelease = wantPrerelease
    // electron-updater's `channel` setter has a side effect: it flips
    // `allowDowngrade=true`. We mutate channel below in the dual-channel path,
    // and the singleton state survives between checks. Reset defensively here
    // so we never offer a downgrade (e.g. user on 0.3.22-rc.1 being offered
    // the older 0.3.21 stable).
    autoUpdater.allowDowngrade = false

    if (!wantPrerelease) {
      // Prereleases off: read the stable `latest` channel only. We must set the
      // channel EXPLICITLY rather than rely on the build's baked default — an rc
      // build bakes `channel: rc` into app-update.yml, so without this an rc user
      // who turns prereleases off would keep reading rc-*.yml and never drop back
      // to the stable line. (For the generic provider `allowPrerelease` is a
      // no-op — the channel file is the only lever — so the channel is what
      // matters here.)
      autoUpdater.channel = 'latest'
      autoUpdater.allowDowngrade = false // channel setter just flipped this on
      await autoUpdater.checkForUpdates()
      return
    }

    // Prereleases on: with the generic provider, each check reads exactly ONE
    // channel file and never auto-discovers others (unlike the old GitHub
    // provider, which enumerated every release). So `allowPrerelease=true` on a
    // single `latest`-channel check does NOT surface an rc — the rc lives in
    // rc-mac.yml, which the `latest` channel never reads. We must explicitly
    // check BOTH the prerelease channel and `latest` and offer whichever version
    // is highest. This applies whether the current build is itself a prerelease
    // OR a stable build whose user opted into prereleases (the reported
    // 0.4.0 → 0.4.1-rc.1 case).

    // Derive the prerelease channel from the current version (e.g. "rc" from
    // "0.3.0-rc.1"); a stable build has no prerelease tag, so default to "rc"
    // (the only prerelease channel we publish). We must set it explicitly
    // because autoUpdater.channel can be null when never set, and assigning null
    // back after changing it corrupts the internal state.
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
    // A missing channel file (latest-mac.yml 404) is benign and self-healing —
    // never report it to Sentry. Silent checks stay quiet; a manual check gets a
    // soft "try again shortly" message rather than a misleading "up to date".
    if (isChannelFileNotFoundError(err)) {
      addErrorBreadcrumb({
        category: 'auto-updater',
        message: 'Update channel file not yet available (latest-mac.yml 404)',
        level: 'info',
        data: { currentVersion: app.getVersion(), operation: 'check' },
      })
      setChannelFilePendingStatus()
      return
    }
    captureException(err, {
      tags: { component: 'auto-updater', operation: 'check' },
      extra: { currentVersion: app.getVersion(), userVisible: runIsUserVisible },
    })
    if (runIsUserVisible) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus({ state: 'error', error: message })
    } else if (currentStatus.state === 'checking') {
      // Silent check failed — clear the spinner the 'checking-for-update' event
      // painted, without surfacing an error the user never asked for. Back to
      // 'idle' ("could not verify"), not 'not-available' (a false "up to date").
      setStatus({ state: 'idle' })
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

    // Dev-only escape hatch: pretend we're an older version so the update feed
    // returns "update available". Activated by SUPERAGENT_TEST_UPDATES=1.
    // SUPERAGENT_FAKE_VERSION overrides the reported version (default 0.0.1).
    // SUPERAGENT_TEST_FEED_URL overrides the generic feed origin (default the
    // prod feed) — point it at a local `wrangler dev` of the gamut-releases
    // Worker (e.g. http://localhost:8787/) to hand-test updates before deploy.
    // Gated on !app.isPackaged so a stray env var on a shipped build can't
    // redirect the auto-updater feed.
    if (process.env.SUPERAGENT_TEST_UPDATES === '1' && !app.isPackaged) {
      const fakeVersion = process.env.SUPERAGENT_FAKE_VERSION || '0.0.1'
      const feedUrl = process.env.SUPERAGENT_TEST_FEED_URL || 'https://updates.gamutagents.com/'
      const cfgPath = path.join(os.tmpdir(), 'superagent-dev-app-update.yml')
      fs.writeFileSync(
        cfgPath,
        `provider: generic\nurl: ${feedUrl}\nchannel: latest\n`,
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
      // checkForUpdates both emits 'error' AND rejects, so a channel-file 404 is
      // seen here too — treat it as benign (no Sentry), mirroring the catch in
      // runUpdateCheckBody: quiet for silent checks, soft retry for manual ones.
      if (isChannelFileNotFoundError(err)) {
        addErrorBreadcrumb({
          category: 'auto-updater',
          message: 'Update channel file not yet available (latest-mac.yml 404)',
          level: 'info',
          data: { currentVersion: app.getVersion(), operation: 'runtime' },
        })
        setChannelFilePendingStatus()
        return
      }
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
      // Errors during a purely silent background check should not flip the UI to
      // an alarming error state — the user never asked for the check. But the
      // 'checking-for-update' event already painted 'checking', so we still have
      // to clear that spinner or the button sticks on it (see runUpdateCheckBody).
      if (runningCheck && !runIsUserVisible) {
        if (currentStatus.state === 'checking') setStatus({ state: 'idle' })
        return
      }
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
