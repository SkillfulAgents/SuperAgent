import { app, BrowserWindow, ipcMain, nativeTheme, shell, Notification } from 'electron'
import path from 'path'
import { EventSource } from 'eventsource'
import { createTray, destroyTray, updateTrayWindow, setTrayVisible } from './tray'
import { createAppMenu, updateAppMenuWindow, destroyAppMenu } from './app-menu'
import { getSettings } from '@shared/lib/config/settings'
import { hostBrowserManager } from './host-browser-manager'
import { registerUpdateHandlers, initAutoUpdater, updateAutoUpdaterWindow } from './auto-updater'

// In dev mode, use a separate data directory to avoid mixing with production data.
// Setting app.name before getPath('userData') changes the resolved directory.
// app.isPackaged is false during `electron-vite dev`, true in production builds.
if (!app.isPackaged) {
  app.name = 'Superagent-Dev'
}

// Set Electron-specific data directory BEFORE importing API
// This uses ~/Library/Application Support/Superagent (or Superagent-Dev) on macOS
// or %APPDATA%/Superagent (or Superagent-Dev) on Windows
// Note: app.getPath() works synchronously before app.whenReady()
process.env.SUPERAGENT_DATA_DIR = app.getPath('userData')
console.log(`Data directory: ${process.env.SUPERAGENT_DATA_DIR}`)

// Register auto-update IPC handlers early (before window creation)
// so the renderer never gets "no handler" errors, even in dev mode
registerUpdateHandlers()

// Now safe to import API (env var is set)
import { serve } from '@hono/node-server'
import api from '../api'
import { containerManager } from '@shared/lib/container/container-manager'
import { taskScheduler } from '@shared/lib/scheduler/task-scheduler'
import { autoSleepMonitor } from '@shared/lib/scheduler/auto-sleep-monitor'
import { listAgents } from '@shared/lib/services/agent-service'
import { findAvailablePort } from './find-port'
import { setupBrowserStreamProxy } from './browser-stream-proxy'

// Set the app name (shows in macOS menu bar instead of "Electron" during dev)
app.name = 'SuperAgent'

// Use a more exotic default port to avoid conflicts
const DEFAULT_API_PORT = 47891
let actualApiPort: number = DEFAULT_API_PORT
let mainWindow: BrowserWindow | null = null
let apiServer: ReturnType<typeof serve> | null = null
let notificationEventSource: EventSource | null = null

// Register custom protocol for OAuth callbacks
// Use a different scheme in dev to avoid conflicts with the installed production app
const PROTOCOL_SCHEME = app.isPackaged ? 'superagent' : 'superagent-dev'
process.env.SUPERAGENT_PROTOCOL = PROTOCOL_SCHEME

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ])
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
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

  // Handle window.open() calls - prevent popup windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Handle file download URLs - download directly without opening a popup
    if (url.includes('/api/agents/') && url.includes('/files/')) {
      mainWindow?.webContents.downloadURL(url)
      return { action: 'deny' }
    }
    // For other URLs (OAuth, external links), open in system browser
    shell.openExternal(url)
    return { action: 'deny' }
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

  // Always set the window ref so IPC status events reach the renderer
  updateAutoUpdaterWindow(mainWindow)

  // Initialize the actual updater only in production builds
  if (!process.env.ELECTRON_RENDERER_URL) {
    initAutoUpdater(mainWindow)
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

// IPC handler for setting native theme (controls vibrancy appearance on macOS)
ipcMain.handle('set-native-theme', (_event, theme: string) => {
  nativeTheme.themeSource = theme as 'system' | 'light' | 'dark'
})

// Handle OAuth callback URLs (macOS)
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLinkUrl(url)
})

function handleDeepLinkUrl(url: string) {
  if (!mainWindow) return

  // Composio OAuth callback
  if (url.startsWith(`${PROTOCOL_SCHEME}://oauth-callback`)) {
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

  // MCP OAuth callback — forward to the local API server to complete token exchange
  if (url.startsWith(`${PROTOCOL_SCHEME}://mcp-oauth-callback`)) {
    try {
      const callbackUrl = new URL(url)
      const queryString = callbackUrl.search
      const apiUrl = `http://localhost:${actualApiPort}/api/remote-mcps/oauth-callback${queryString}`
      fetch(apiUrl)
        .then(async (res) => {
          const text = await res.text()
          const success = text.includes('OAuth successful')
          const mcpIdMatch = text.match(/mcpId:\s*'([^']+)'/)
          mainWindow?.webContents.send('mcp-oauth-callback', {
            success,
            mcpId: mcpIdMatch?.[1] || null,
            error: success ? null : 'OAuth failed',
          })
        })
        .catch((err) => {
          console.error('Failed to complete MCP OAuth callback:', err)
          mainWindow?.webContents.send('mcp-oauth-callback', {
            success: false,
            error: err.message || 'Failed to complete OAuth',
          })
        })
      mainWindow.focus()
    } catch (error) {
      console.error('Failed to parse MCP OAuth callback URL:', error)
      mainWindow.webContents.send('mcp-oauth-callback', {
        success: false,
        error: 'Invalid callback URL',
      })
    }
  }
}

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
    process.env.PORT = String(actualApiPort)
    console.log(`Found available port: ${actualApiPort}`)
  } catch (error) {
    console.error('Failed to find available port:', error)
    app.quit()
    return
  }

  // Start the API server
  apiServer = serve({ fetch: api.fetch, port: actualApiPort }, () => {
    console.log(`API server running on http://localhost:${actualApiPort}`)

    // Initialize container manager with all agents and start status sync
    listAgents().then((agents) => {
      const slugs = agents.map((a) => a.slug)
      return containerManager.initializeAgents(slugs)
    }).then(() => {
      // Check image availability and pull if needed (non-blocking)
      containerManager.ensureImageReady().catch((error) => {
        console.error('Failed to ensure image ready:', error)
      })
      containerManager.startStatusSync()
      containerManager.startHealthMonitor()
    }).catch((error) => {
      console.error('Failed to initialize container manager:', error)
    })

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

  // Create the application menu (macOS menu bar)
  createAppMenu(mainWindow, actualApiPort)

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
      // Update tray, menu, and auto-updater with new window reference
      updateTrayWindow(mainWindow)
      updateAppMenuWindow(mainWindow)
      updateAutoUpdaterWindow(mainWindow)
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
  app.on('second-instance', (_event, commandLine) => {
    // Handle protocol URLs on Windows/Linux
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`))
    if (url) {
      handleDeepLinkUrl(url)
      if (mainWindow?.isMinimized()) mainWindow.restore()
      mainWindow?.focus()
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

  // Destroy tray and app menu
  destroyTray()
  destroyAppMenu()

  // Stop all host browser instances
  hostBrowserManager.stopAll()

  // Stop the task scheduler, auto-sleep monitor, and status sync
  taskScheduler.stop()
  autoSleepMonitor.stop()
  containerManager.stopStatusSync()

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
