import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, nativeTheme, session, shell, Notification } from 'electron'
import { execFileSync, exec } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

// todo huge file - need to break up into multiple modules (tray, menu, auto-updater, host-browser provider, etc.)

// Fix PATH for packaged Electron apps on macOS.
// Without this, the app only sees /usr/bin:/bin:/usr/sbin:/sbin and can't find
// tools like `gh` or `git` installed via Homebrew.
if (process.platform !== 'win32') {
  try {
    const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'echo -n "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    }).trim()
    if (shellPath) {
      process.env.PATH = shellPath
    }
  } catch {
    // Fall back to adding common paths
    const common = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']
    const current = process.env.PATH || ''
    process.env.PATH = [...common.filter((p) => !current.includes(p)), current].join(':')
  }
}

import { EventSource } from 'eventsource'
import { createTray, destroyTray, updateTrayWindow, setTrayVisible } from './tray'
import { createAppMenu, updateAppMenuWindow, destroyAppMenu } from './app-menu'
import { getSettings } from '@shared/lib/config/settings'
import { detectAllProviders } from './host-browser'
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
// Respect SUPERAGENT_DATA_DIR if already set (e.g. for local dev with a custom data dir)
process.env.SUPERAGENT_DATA_DIR ??= app.getPath('userData')
console.log(`Data directory: ${process.env.SUPERAGENT_DATA_DIR}`)

// Initialize error reporting as early as possible (after data dir is set)
import { initErrorReporting, captureException, flushErrorReporting } from '@shared/lib/error-reporting'

// Only report errors in production builds — dev mode generates too much noise
if (app.isPackaged) {
  initErrorReporting({ environment: 'electron' })
}

// Register auto-update IPC handlers early (before window creation)
// so the renderer never gets "no handler" errors, even in dev mode
registerUpdateHandlers()

// Now safe to import API (env var is set)
import { serve } from '@hono/node-server'
import api from '../api'
import { initializeServices, shutdownServices } from '@shared/lib/startup'
import { findAvailablePort } from './find-port'
import { setupServerHandlers } from '@shared/lib/startup'

// Set the app name (shows in macOS menu bar instead of "Electron" during dev)
app.name = 'SuperAgent'

// Force overlay scrollbars so macOS "always show scrollbars" setting doesn't
// cause ugly permanent scrollbars in the app
if (process.platform === 'darwin') {
  const { systemPreferences } = require('electron')
  systemPreferences.setUserDefault('AppleShowScrollBars', 'string', 'WhenScrolling')
}

// Use a more exotic default port to avoid conflicts
const DEFAULT_API_PORT = 47891
let actualApiPort: number = DEFAULT_API_PORT
let mainWindow: BrowserWindow | null = null
const dashboardWindows: Map<string, BrowserWindow> = new Map()
let apiServer: ReturnType<typeof serve> | null = null
let notificationEventSource: EventSource | null = null
let apiReady = false
const pendingDashboardLinks: { agentSlug: string; dashboardSlug: string }[] = []
const pendingProtocolUrls: string[] = []

function openDashboardWindow(agentSlug: string, dashboardSlug: string) {
  const key = `${agentSlug}/${dashboardSlug}`

  // Focus existing window if already open
  const existing = dashboardWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const url = `http://localhost:${actualApiPort}/api/agents/${agentSlug}/artifacts/${dashboardSlug}/view`
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'SuperAgent Dashboard',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadURL(url)
  dashboardWindows.set(key, win)
  win.on('closed', () => dashboardWindows.delete(key))
}

// Register custom protocol for OAuth callbacks
// Use a different scheme in dev to avoid conflicts with the installed production app
const PROTOCOL_SCHEME = app.isPackaged ? 'superagent' : 'superagent-dev'
process.env.SUPERAGENT_PROTOCOL = PROTOCOL_SCHEME

if (!app.isPackaged && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
    path.resolve(process.argv[1]),
  ])
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
}

function canHandleDeepLinkNow(url: string) {
  if (url.startsWith(`${PROTOCOL_SCHEME}://dashboard/`)) {
    return apiReady
  }

  if (url.startsWith(`${PROTOCOL_SCHEME}://oauth-callback`)) {
    return !!mainWindow
  }

  if (
    url.startsWith(`${PROTOCOL_SCHEME}://mcp-oauth-callback`) ||
    url.startsWith(`${PROTOCOL_SCHEME}://platform-auth-callback`)
  ) {
    return !!mainWindow && apiReady
  }

  return !!mainWindow
}

function processPendingProtocolUrls() {
  if (pendingProtocolUrls.length === 0) {
    return
  }

  const remaining: string[] = []
  for (const url of pendingProtocolUrls) {
    if (canHandleDeepLinkNow(url)) {
      handleDeepLinkUrl(url, true)
    } else {
      remaining.push(url)
    }
  }

  pendingProtocolUrls.length = 0
  pendingProtocolUrls.push(...remaining)
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
      spellcheck: true,
    },
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 16 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'active' as const,
    }),
    ...(process.platform === 'win32' && {
      backgroundMaterial: 'acrylic' as const,
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        height: 48,
        color: '#00000000',
        symbolColor: '#888888',
      },
    }),
  })

  // Grant microphone (and camera) permissions for the renderer.
  // Production loads from file:// where Chromium blocks getUserMedia by default.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write']
    callback(allowed.includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['media', 'audioCapture', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write']
    return allowed.includes(permission)
  })

  // Spellcheck context menu — show correction suggestions on right-click
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (params.misspelledWord) {
      const menu = new Menu()
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(new MenuItem({
          label: suggestion,
          click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
        }))
      }
      if (params.dictionarySuggestions.length > 0) {
        menu.append(new MenuItem({ type: 'separator' }))
      }
      menu.append(new MenuItem({
        label: 'Add to Dictionary',
        click: () => mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      }))
      menu.popup()
    }
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

  processPendingProtocolUrls()
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

// IPC handler for launching an elevated PowerShell window (Windows only)
ipcMain.handle('launch-powershell-admin', (_event, command: string) => {
  if (process.platform !== 'win32') {
    throw new Error('PowerShell admin launch is only supported on Windows')
  }
  const allowedCommands = ['wsl --install']
  if (!allowedCommands.includes(command)) {
    throw new Error('Command not allowed')
  }
  return new Promise<void>((resolve, reject) => {
    // Use exec with shell:true so cmd.exe handles the quoting.
    // Start-Process -Verb RunAs triggers the UAC elevation prompt.
    const psCommand = `Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoExit -Command ${command}'`
    exec(`powershell.exe -Command "${psCommand}"`, (error) => {
      if (error) {
        console.error('Failed to launch elevated PowerShell:', error)
        reject(new Error(`Failed to launch PowerShell: ${error.message}`))
      } else {
        resolve()
      }
    })
  })
})

// IPC handler for reclaiming window focus (e.g. after Chrome steals it)
ipcMain.on('focus-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // app.focus() activates the app at the OS level (calls [NSApp activateIgnoringOtherApps:YES] on macOS),
    // which is required to steal focus back from Chrome. mainWindow.focus() alone doesn't work cross-app.
    app.focus({ steal: true })
    mainWindow.focus()
  }
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
  return { providers: detectAllProviders() }
})

// IPC handler for opening a native directory picker
ipcMain.handle('open-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

// IPC handler for showing the native emoji picker (macOS/Windows)
ipcMain.handle('show-emoji-panel', () => {
  app.showEmojiPanel()
})

// IPC handler for opening a dashboard in a separate window
ipcMain.handle('open-dashboard-window', (_event, { agentSlug, dashboardSlug }: { agentSlug: string; dashboardSlug: string }) => {
  openDashboardWindow(agentSlug, dashboardSlug)
})

// IPC handler for creating a macOS dock shortcut for a dashboard
ipcMain.handle('create-dock-shortcut', (_event, { agentSlug, dashboardSlug, dashboardName, iconPng }: { agentSlug: string; dashboardSlug: string; dashboardName: string; iconPng: number[] }) => {
  const iconBuffer = Buffer.from(iconPng)

  // Create temp directory for iconset generation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-icon-'))
  try {
    const iconsetDir = path.join(tmpDir, 'AppIcon.iconset')
    fs.mkdirSync(iconsetDir)

    // Write base 512x512 PNG
    const basePng = path.join(tmpDir, 'base.png')
    fs.writeFileSync(basePng, iconBuffer)

    // Generate all required iconset sizes using sips (macOS built-in)
    const sizes = [
      { name: 'icon_16x16.png', size: 16 },
      { name: 'icon_16x16@2x.png', size: 32 },
      { name: 'icon_32x32.png', size: 32 },
      { name: 'icon_32x32@2x.png', size: 64 },
      { name: 'icon_128x128.png', size: 128 },
      { name: 'icon_128x128@2x.png', size: 256 },
      { name: 'icon_256x256.png', size: 256 },
      { name: 'icon_256x256@2x.png', size: 512 },
      { name: 'icon_512x512.png', size: 512 },
    ]
    for (const { name, size } of sizes) {
      execFileSync('sips', ['-z', String(size), String(size), basePng, '--out', path.join(iconsetDir, name)])
    }

    // Generate .icns
    const icnsPath = path.join(tmpDir, 'AppIcon.icns')
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath])

    // Create .app bundle
    const sanitizedName = dashboardName.replace(/[/\\:*?"<>|]/g, '-').trim() || dashboardSlug
    const appsDir = path.join(os.homedir(), 'Applications')
    fs.mkdirSync(appsDir, { recursive: true })

    const appPath = path.join(appsDir, `${sanitizedName}.app`)

    // Remove old .app if it exists so icon cache doesn't serve a stale icon
    if (fs.existsSync(appPath)) {
      // Unregister just this app from Launch Services before deleting
      const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
      try {
        execFileSync(lsregister, ['-u', appPath])
      } catch {
        // non-critical
      }
      fs.rmSync(appPath, { recursive: true, force: true })
    }

    const contentsDir = path.join(appPath, 'Contents')
    const macosDir = path.join(contentsDir, 'MacOS')
    const resourcesDir = path.join(contentsDir, 'Resources')
    fs.mkdirSync(macosDir, { recursive: true })
    fs.mkdirSync(resourcesDir, { recursive: true })

    // Write Info.plist
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${sanitizedName}</string>
  <key>CFBundleDisplayName</key>
  <string>${sanitizedName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.superagent.dashboard.${agentSlug}.${dashboardSlug}</string>
  <key>CFBundleVersion</key>
  <string>${Date.now()}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>`
    fs.writeFileSync(path.join(contentsDir, 'Info.plist'), plist)

    // Write launcher script that opens the deep link
    const launcher = `#!/bin/bash\nopen "${PROTOCOL_SCHEME}://dashboard/${encodeURIComponent(agentSlug)}/${encodeURIComponent(dashboardSlug)}"\n`
    const launcherPath = path.join(macosDir, 'launcher')
    fs.writeFileSync(launcherPath, launcher)
    fs.chmodSync(launcherPath, '755')

    // Copy icon
    fs.copyFileSync(icnsPath, path.join(resourcesDir, 'AppIcon.icns'))

    // Remove macOS protection attributes so the app can launch
    for (const attr of ['com.apple.quarantine', 'com.apple.provenance']) {
      try {
        execFileSync('xattr', ['-rd', attr, appPath])
      } catch {
        // Attribute may not be present, that's fine
      }
    }

    // Add to macOS Dock
    try {
      const dockEntry = `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${appPath}</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>`
      execFileSync('defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', dockEntry])
      execFileSync('killall', ['Dock'])
    } catch (error) {
      console.error('Failed to add to Dock:', error)
    }

    // Reveal in Finder so the user can see where it lives
    shell.showItemInFolder(appPath)
  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// IPC handler for setting native theme (controls vibrancy appearance on macOS)
ipcMain.handle('set-native-theme', (_event, theme: string) => {
  nativeTheme.themeSource = theme as 'system' | 'light' | 'dark'

  // Update Windows title bar overlay symbol color to match theme
  if (process.platform === 'win32' && mainWindow) {
    const isDark = nativeTheme.shouldUseDarkColors
    mainWindow.setTitleBarOverlay({
      symbolColor: isDark ? '#cccccc' : '#333333',
      color: '#00000000',
    })
  }
})

// IPC handler for popping up the full app menu at a position (Windows custom title bar)
ipcMain.handle('popup-app-menu', (_event, x: number, y: number) => {
  const appMenu = Menu.getApplicationMenu()
  const win = mainWindow
  if (!appMenu || !win) return
  // Build a nested menu with top-level items as submenus
  const items: Electron.MenuItemConstructorOptions[] = []
  for (const topItem of appMenu.items) {
    if (topItem.submenu) {
      const subItems: Electron.MenuItemConstructorOptions[] = topItem.submenu.items.map(subItem => ({
        label: subItem.label,
        type: subItem.type,
        role: subItem.role as any,
        accelerator: subItem.accelerator || undefined,
        enabled: subItem.enabled,
        click: subItem.click ? () => subItem.click!(subItem as any, win, {} as any) : undefined,
      }))
      items.push({ label: topItem.label, submenu: subItems })
    }
  }
  const menu = Menu.buildFromTemplate(items)
  menu.popup({ window: win, x, y })
})

// Handle OAuth callback URLs (macOS)
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLinkUrl(url)
})

function handleDeepLinkUrl(url: string, fromQueue = false) {
  if (!fromQueue && !canHandleDeepLinkNow(url)) {
    pendingProtocolUrls.push(url)
    return
  }

  // Dashboard deep links — open in a standalone window (doesn't need mainWindow)
  if (url.startsWith(`${PROTOCOL_SCHEME}://dashboard/`)) {
    try {
      const stripped = url.replace(`${PROTOCOL_SCHEME}://dashboard/`, '')
      const parts = stripped.split('/')
      const agentSlug = decodeURIComponent(parts[0])
      const dashboardSlug = decodeURIComponent(parts[1])
      if (apiReady) {
        openDashboardWindow(agentSlug, dashboardSlug)
      } else {
        pendingDashboardLinks.push({ agentSlug, dashboardSlug })
      }
    } catch (error) {
      console.error('Failed to open dashboard from deep link:', error)
    }
    return
  }

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

  if (url.startsWith(`${PROTOCOL_SCHEME}://platform-auth-callback`)) {
    try {
      const callbackUrl = new URL(url)
      const error = callbackUrl.searchParams.get('error')
      if (error) {
        mainWindow.webContents.send('platform-auth-callback', {
          success: false,
          error,
        })
        mainWindow.focus()
        return
      }

      const token = callbackUrl.searchParams.get('token')
      if (!token) {
        mainWindow.webContents.send('platform-auth-callback', {
          success: false,
          error: 'Missing platform token in callback URL',
        })
        mainWindow.focus()
        return
      }

      const email = callbackUrl.searchParams.get('email')
      const label = callbackUrl.searchParams.get('label') || 'SuperAgent'
      const orgName = callbackUrl.searchParams.get('org_name')
      const role = callbackUrl.searchParams.get('role')
      const apiUrl = `http://localhost:${actualApiPort}/api/platform-auth/complete`

      fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token,
          email,
          label,
          orgName,
          role,
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const payload = await res.json().catch(() => ({ error: 'Failed to save platform token' }))
            mainWindow?.webContents.send('platform-auth-callback', {
              success: false,
              error: payload.error || 'Failed to save platform token',
            })
            return
          }

          mainWindow?.webContents.send('platform-auth-callback', {
            success: true,
            email,
          })
        })
        .catch((err) => {
          console.error('Failed to complete platform auth callback:', err)
          mainWindow?.webContents.send('platform-auth-callback', {
            success: false,
            error: err.message || 'Failed to complete platform auth callback',
          })
        })

      mainWindow.focus()
      return
    } catch (error) {
      console.error('Failed to parse platform auth callback URL:', error)
      mainWindow.webContents.send('platform-auth-callback', {
        success: false,
        error: 'Invalid platform callback URL',
      })
      return
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

      if (data.type === 'system_alert') {
        dialog.showMessageBox({
          type: data.level || 'warning',
          title: data.title,
          message: data.title,
          detail: data.body,
          buttons: ['OK'],
        }).catch(() => {})
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
  apiServer = serve({ fetch: api.fetch, port: actualApiPort, hostname: '0.0.0.0' }, () => {
    console.log(`API server running on http://localhost:${actualApiPort}`)

    // Initialize all background services
    initializeServices().catch((error) => {
      console.error('Failed to initialize services:', error)
    })

    // Start listening for notifications (for when window is closed)
    startNotificationListener()

    // Mark API as ready and process any queued dashboard deep links
    apiReady = true
    for (const link of pendingDashboardLinks) {
      openDashboardWindow(link.agentSlug, link.dashboardSlug)
    }
    pendingDashboardLinks.length = 0
    processPendingProtocolUrls()
  })

  // Set up server-level handlers (WebSocket proxies, etc.)
  setupServerHandlers(apiServer)

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
  // On macOS and Windows, keep app running in the background (system tray)
  // On Linux, quit when all windows are closed
  if (process.platform === 'linux') {
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

  // Close all dashboard windows
  for (const win of dashboardWindows.values()) {
    if (!win.isDestroyed()) win.close()
  }
  dashboardWindows.clear()

  // Destroy tray and app menu
  destroyTray()
  destroyAppMenu()

  // Stop all background services and containers
  try {
    await shutdownServices()
    console.log('All services stopped.')
  } catch (error) {
    console.error('Error stopping services:', error)
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

    // Hard deadline: force-exit if graceful shutdown hangs (e.g., stuck Lima VM)
    // Must exceed the full escalation chain: stop(10s) + kill(5s) + forceStop(10s) = 25s
    const forceExitTimer = setTimeout(() => {
      console.error('Graceful shutdown timed out after 35s — force exiting')
      process.exit(1)
    }, 35000)
    forceExitTimer.unref() // Don't keep the event loop alive just for this timer

    await gracefulShutdown()
    clearTimeout(forceExitTimer)
    app.quit()
  }
})

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error)
  captureException(error, { tags: { type: 'uncaughtException' }, level: 'fatal' })
  await flushErrorReporting(3000)
  await gracefulShutdown()
  app.quit()
})

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason)
  captureException(reason instanceof Error ? reason : new Error(String(reason)), { tags: { type: 'unhandledRejection' }, level: 'fatal' })
  await flushErrorReporting(3000)
  await gracefulShutdown()
  app.quit()
})
