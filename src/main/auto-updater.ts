import { BrowserWindow, ipcMain, app } from 'electron'
import { getSettings } from '@shared/lib/config/settings'

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
 * Register IPC handlers for auto-update. Call this unconditionally
 * so the renderer never gets "no handler registered" errors.
 */
export function registerUpdateHandlers() {
  ipcMain.handle('get-update-status', () => {
    return currentStatus
  })

  ipcMain.handle('check-for-updates', async () => {
    if (!updaterReady) {
      setStatus({ state: 'error', error: 'Auto-update is not available in development mode' })
      return
    }
    try {
      const autoUpdater = await getAutoUpdater()
      const isPreRelease = app.getVersion().includes('-')
      const wantPrerelease = isPreRelease || !!getSettings().app?.allowPrereleaseUpdates

      autoUpdater.allowPrerelease = wantPrerelease

      if (!isPreRelease) {
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
        await autoUpdater.checkForUpdates()
      }

      // If neither check found anything newer, make sure UI reflects that
      if (!preVer && !stableVer) {
        setStatus({ state: 'not-available' })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus({ state: 'error', error: message })
    }
  })

  ipcMain.handle('download-update', async () => {
    if (!updaterReady) return
    try {
      const autoUpdater = await getAutoUpdater()
      await autoUpdater.downloadUpdate()
    } catch (err) {
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

    // Don't auto-download — let the user choose
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    const isPreRelease = app.getVersion().includes('-')
    autoUpdater.allowPrerelease = isPreRelease || !!getSettings().app?.allowPrereleaseUpdates

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
      setStatus({ state: 'error', error: err.message })
    })

    updaterReady = true
  } catch (err) {
    console.warn('Failed to initialize auto-updater:', err)
  }
}

export function updateAutoUpdaterWindow(window: BrowserWindow | null) {
  mainWindowRef = window
}
