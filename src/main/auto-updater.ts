import { BrowserWindow, ipcMain } from 'electron'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }
let mainWindowRef: BrowserWindow | null = null
let updaterReady = false

async function getAutoUpdater() {
  const mod = await import('electron-updater')
  return mod.autoUpdater ?? (mod as any).default?.autoUpdater
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
      await autoUpdater.checkForUpdates()
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
