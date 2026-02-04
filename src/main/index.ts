import { app, BrowserWindow, ipcMain, shell, Notification } from 'electron'
import path from 'path'
import { EventSource } from 'eventsource'
import { createTray, destroyTray, updateTrayWindow, setTrayVisible } from './tray'
import { getSettings } from '@shared/lib/config/settings'
import { hostBrowserManager } from './host-browser-manager'

// Set Electron-specific data directory BEFORE importing API
// This uses ~/Library/Application Support/Superagent on macOS
// or %APPDATA%/Superagent on Windows
// Note: app.getPath() works synchronously before app.whenReady()
process.env.SUPERAGENT_DATA_DIR = app.getPath('userData')
console.log(`Data directory: ${process.env.SUPERAGENT_DATA_DIR}`)

// Now safe to import API (env var is set)
import { serve } from '@hono/node-server'
import api from '../api'
import { containerManager } from '@shared/lib/container/container-manager'
import { taskScheduler } from '@shared/lib/scheduler/task-scheduler'
import { autoSleepMonitor } from '@shared/lib/scheduler/auto-sleep-monitor'
import { findAvailablePort } from './find-port'
import { setupBrowserStreamProxy } from './browser-stream-proxy'

// Use a more exotic default port to avoid conflicts
const DEFAULT_API_PORT = 47891
let actualApiPort: number = DEFAULT_API_PORT
let mainWindow: BrowserWindow | null = null
let apiServer: ReturnType<typeof serve> | null = null
let notificationEventSource: EventSource | null = null

// Register custom protocol for OAuth callbacks
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('superagent', process.execPath, [
      path.resolve(process.argv[1]),
    ])
  }
} else {
  app.setAsDefaultProtocolClient('superagent')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === 'darwin' && { // translucent window on macOS for the sidebar
      vibrancy: 'sidebar' as const,
      visualEffectState: 'active' as const,
    }),
  })

  // Load the app
  if (process.env.ELECTRON_RENDERER_URL) {
    // Development: use Vite dev server
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    // Production: load built files
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Emit full screen state changes
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', true)
  })

  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', false)
  })
}

// IPC handler for getting full screen state
ipcMain.handle('get-fullscreen-state', () => {
  return mainWindow?.isFullScreen() ?? false
})

// IPC handler for getting the API URL (port may vary)
ipcMain.handle('get-api-url', () => {
  return `http://localhost:${actualApiPort}`
})

// IPC handler for opening URLs in system browser
ipcMain.handle('open-external', async (_event, url: string) => {
  await shell.openExternal(url)
})

// IPC handler for tray visibility
ipcMain.handle('set-tray-visible', (_event, visible: boolean) => {
  setTrayVisible(visible)
})

// IPC handler for showing OS notifications
ipcMain.handle('show-notification', (_event, { title, body }: { title: string; body: string }) => {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    notification.show()
  }
})

// IPC handler for setting dock badge count (macOS)
ipcMain.handle('set-badge-count', (_event, count: number) => {
  if (process.platform === 'darwin') {
    app.setBadgeCount(count)
  }
})

// IPC handler for detecting host browser availability
ipcMain.handle('detect-host-browser', () => {
  return hostBrowserManager.detect()
})

// Handle OAuth callback URLs (macOS)
app.on('open-url', (event, url) => {
  event.preventDefault()

  // Parse the callback URL and extract OAuth parameters
  if (mainWindow && url.startsWith('superagent://oauth-callback')) {
    try {
      const callbackUrl = new URL(url)
      const params = {
        connectionId: callbackUrl.searchParams.get('connectedAccountId'),
        status: callbackUrl.searchParams.get('status'),
        toolkit: callbackUrl.searchParams.get('toolkit'),
        error: callbackUrl.searchParams.get('error'),
      }
      mainWindow.webContents.send('oauth-callback', params)
      mainWindow.focus()
    } catch (error) {
      console.error('Failed to parse OAuth callback URL:', error)
      mainWindow.webContents.send('oauth-callback', { error: 'Invalid callback URL' })
    }
  }
})

// Start listening for global notifications via SSE
// This handles notifications when the window is closed
function startNotificationListener(): void {
  if (notificationEventSource) {
    notificationEventSource.close()
  }

  const url = `http://localhost:${actualApiPort}/api/notifications/stream`
  const es = new EventSource(url)
  notificationEventSource = es

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)

      if (data.type === 'os_notification') {
        // Only show notification if window is closed/destroyed
        // If window exists, the renderer will handle it
        if (!mainWindow || mainWindow.isDestroyed()) {
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: data.title,
              body: data.body,
            })
            notification.on('click', () => {
              // Recreate window and navigate to the session
              app.emit('activate')
            })
            notification.show()
          }
        }
      }
    } catch {
      // Ignore parse errors for ping messages etc
    }
  }

  es.onerror = () => {
    console.error('[Main] Notification stream error')
    // EventSource will auto-reconnect
  }

  es.onopen = () => {
    // Connected to notification stream
  }
}

// Stop the notification listener
function stopNotificationListener(): void {
  if (notificationEventSource) {
    notificationEventSource.close()
    notificationEventSource = null
  }
}

// Start the API server and app
async function startApp() {
  // Find an available port
  try {
    actualApiPort = await findAvailablePort(DEFAULT_API_PORT)
    console.log(`Found available port: ${actualApiPort}`)
  } catch (error) {
    console.error('Failed to find available port:', error)
    app.quit()
    return
  }

  // Start the API server
  apiServer = serve({ fetch: api.fetch, port: actualApiPort }, () => {
    console.log(`API server running on http://localhost:${actualApiPort}`)

    // Start the task scheduler after API server is ready
    taskScheduler.start().catch((error) => {
      console.error('Failed to start task scheduler:', error)
    })

    // Start the auto-sleep monitor
    autoSleepMonitor.start().catch((error) => {
      console.error('Failed to start auto-sleep monitor:', error)
    })

    // Start listening for notifications (for when window is closed)
    startNotificationListener()
  })

  // Set up WebSocket upgrade handler for browser stream proxy
  setupBrowserStreamProxy(apiServer)

  // Wait for app to be ready, then create window
  await app.whenReady()
  createWindow()

  // Create system tray if enabled in settings
  const settings = getSettings()
  if (settings.app?.showMenuBarIcon !== false) {
    createTray(mainWindow, actualApiPort)
  }
}

startApp()

// App lifecycle - handle activate separately
app.whenReady().then(() => {

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      // Update tray with new window reference
      updateTrayWindow(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, keep app running until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Handle second instance (Windows/Linux deep links)
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine) => {
    // Handle protocol URL on Windows/Linux
    const url = commandLine.find((arg) => arg.startsWith('superagent://oauth-callback'))
    if (url && mainWindow) {
      try {
        const callbackUrl = new URL(url)
        const params = {
          connectionId: callbackUrl.searchParams.get('connectedAccountId'),
          status: callbackUrl.searchParams.get('status'),
          toolkit: callbackUrl.searchParams.get('toolkit'),
          error: callbackUrl.searchParams.get('error'),
        }
        mainWindow.webContents.send('oauth-callback', params)
      } catch (error) {
        console.error('Failed to parse OAuth callback URL:', error)
        mainWindow.webContents.send('oauth-callback', { error: 'Invalid callback URL' })
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Graceful shutdown handling
let isShuttingDown = false

async function gracefulShutdown() {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('Shutting down gracefully...')

  // Stop notification listener
  stopNotificationListener()

  // Destroy tray
  destroyTray()

  // Stop host browser if we launched it
  hostBrowserManager.stop()

  // Stop the task scheduler and auto-sleep monitor
  taskScheduler.stop()
  autoSleepMonitor.stop()

  // Stop all containers
  try {
    await containerManager.stopAll()
    console.log('All containers stopped.')
  } catch (error) {
    console.error('Error stopping containers:', error)
  }

  // Close the API server
  if (apiServer) {
    apiServer.close(() => {
      console.log('API server closed.')
    })
  }
}

// Handle app quit
app.on('before-quit', async (event) => {
  if (!isShuttingDown) {
    event.preventDefault()
    await gracefulShutdown()
    app.quit()
  }
})

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error)
  await gracefulShutdown()
  app.quit()
})

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason)
  await gracefulShutdown()
  app.quit()
})
