import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, nativeImage, nativeTheme, powerMonitor, session, shell, Notification } from 'electron'
import { execFileSync, exec } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { z } from 'zod'

const ShowInFolderPath = z.string().min(1)

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
import { createAppMenu, updateAppMenuWindow, destroyAppMenu, flushPendingMenuCommands } from './app-menu'
import { getSettings } from '@shared/lib/config/settings'
import { detectAllProviders } from './host-browser'
import { registerUpdateHandlers, initAutoUpdater, updateAutoUpdaterWindow } from './auto-updater'
import { enableKeepAwake, disableKeepAwake, cleanupKeepAwake, restoreKeepAwakeOnStartup } from './keep-awake'
import { openDashboardWindow, installPopupHandler, closeAllDashboardWindows } from './dashboard-window'
import {
  prewarmQuickDispatchWindow,
  toggleQuickDispatchWindow,
  hideQuickDispatchWindow,
  closeQuickDispatchWindow,
  setQuickDispatchModal,
  setQuickDispatchContentHeight,
  startQuickDispatchDrag,
  moveQuickDispatchDrag,
  endQuickDispatchDrag,
  openQuickDispatchWithFile,
  drainQuickDispatchAttachPaths,
} from './quick-dispatch-window'
import { registerGlobalDispatchShortcut, unregisterGlobalDispatchShortcut } from './global-dispatch-shortcut'
import { filesFromCommandLine } from './opened-files'
import { safeOpenExternalFromApp } from './safe-open-external'

// In dev mode, use a separate data directory to avoid mixing with production data.
// Setting app.name before getPath('userData') changes the resolved directory.
// app.isPackaged is false during `electron-vite dev`, true in production builds.
if (!app.isPackaged) {
  app.name = 'Superagent-Dev'
}

// Set Electron-specific data directory BEFORE importing API.
//
// LOAD-BEARING (Gamut rebrand — DATA-0 / FIX H1): the production data dir is pinned to
// the legacy "Superagent" folder, deliberately decoupled from the now-"Gamut" productName.
// `getPath('userData')` resolves to `appData/<productName>`, so flipping productName to
// "Gamut" *without* this pin would point every installed user at an empty `…/Gamut` and
// strand their DB, secrets, and history in the old `…/Superagent` tree. We derive the pin
// from the brand-independent `appData` base + the literal legacy name so the data location
// never moves regardless of the visible brand. Do NOT change the literal 'Superagent'.
// (See gamut-rebrand-roadmap.md §3.1.)
//
// Dev is unaffected: app.name is set to 'Superagent-Dev' above (pre-resolution), so the
// fallback below resolves dev data to `…/Superagent-Dev`. A pre-existing SUPERAGENT_DATA_DIR
// (custom dev/CI dir) is always honored verbatim via `??=`.
if (app.isPackaged) {
  process.env.SUPERAGENT_DATA_DIR ??= path.join(app.getPath('appData'), 'Superagent')
}
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
import { setupServerHandlers } from '@shared/lib/startup'
import { bindServerWithRetry } from '@shared/lib/server-bind'
import { chatIntegrationManager } from '@shared/lib/chat-integrations/chat-integration-manager'
import { getUserSettings } from '@shared/lib/services/user-settings-service'

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
let apiServer: ReturnType<typeof serve> | null = null
let notificationEventSource: EventSource | null = null
let apiReady = false
const pendingDashboardLinks: { agentSlug: string; dashboardSlug: string }[] = []
const pendingProtocolUrls: string[] = []
// Queues for notifications fired while the window was closed. The renderer
// pulls these on mount via the `flush-pending-notification-events` IPC so no
// click/action gets lost to the inevitable `webContents.send` race against
// useEffect mounting the listeners. Capped to bound memory if the user
// leaves the window closed for a long time and many notifications fire
// (review S2): on overflow we drop the oldest entry, since stale events
// for resolved/timed-out reviews would 404 on dispatch anyway.
const PENDING_NOTIFICATION_QUEUE_MAX = 50
const pendingNotificationEvents: Array<{
  type: 'click' | 'action'
  actionIndex?: number
  context?: unknown
}> = []
const pendingNotificationNavigations: Array<{
  agentSlug: string
  sessionId: string | null
}> = []

function pushPendingNotificationEvent(evt: {
  type: 'click' | 'action'
  actionIndex?: number
  context?: unknown
}): void {
  if (pendingNotificationEvents.length >= PENDING_NOTIFICATION_QUEUE_MAX) {
    pendingNotificationEvents.shift()
  }
  pendingNotificationEvents.push(evt)
}

function pushPendingNavigation(nav: { agentSlug: string; sessionId: string | null }): void {
  if (pendingNotificationNavigations.length >= PENDING_NOTIFICATION_QUEUE_MAX) {
    pendingNotificationNavigations.shift()
  }
  pendingNotificationNavigations.push(nav)
}

// Strong references to Notification objects so the JS GC doesn't reap them
// while macOS is still showing them (e.g. user opens the action dropdown
// after the banner has been on screen for a couple of seconds). When the
// JS object is collected, the underlying NSUserNotification listeners
// detach and macOS routes the action click into the void.
//
// macOS doesn't always fire `close` (notifications migrate silently into
// Notification Center), so we ALSO TTL each entry. We pick a value slightly
// above the proxy-review timeout (5 min, see review-manager.ts) so an
// action click at minute 4 still has a live JS Notification to dispatch
// from — past that the underlying review has timed out anyway and the
// click would 404. (Review S1.)
const NOTIFICATION_TTL_MS = 6 * 60 * 1000
const liveNotifications = new Set<Notification>()
// Track notifications by reviewId so we can dismiss the OS notification
// when the underlying review resolves (in-app, by another viewer, or by
// timeout). Without this, stale "API Request Review" notifications linger
// in Notification Center and clicking Approve/Deny on them 404s. (Review S8.)
const reviewNotifications = new Map<string, Notification>()
function trackLiveNotification(notification: Notification, reviewId?: string): void {
  liveNotifications.add(notification)
  if (reviewId) reviewNotifications.set(reviewId, notification)
  setTimeout(() => {
    liveNotifications.delete(notification)
    if (reviewId) reviewNotifications.delete(reviewId)
  }, NOTIFICATION_TTL_MS).unref()
}
function dismissReviewNotification(reviewId: string): void {
  const n = reviewNotifications.get(reviewId)
  if (n) {
    n.close()
    reviewNotifications.delete(reviewId)
    liveNotifications.delete(n)
  }
}

/**
 * Local-user equivalent of the renderer's `isNotificationTypeEnabled` check.
 * Used by the closed-window SSE fallback (the only main-process notification
 * path; the IPC handler runs after the renderer's gate so it doesn't need
 * this check itself).
 */
function isNotificationTypeAllowedLocally(notificationType: string | undefined): boolean {
  try {
    const settings = getUserSettings('local')
    const n = settings.notifications
    if (!n.enabled) return false
    switch (notificationType) {
      case 'session_complete':
        return n.sessionComplete !== false
      case 'session_waiting':
        return n.sessionWaiting !== false
      case 'session_scheduled':
        return n.sessionScheduled !== false
      default:
        return true
    }
  } catch {
    // If settings can't be loaded, default to showing the notification —
    // failing closed would silently drop notifications on a misconfigured
    // install, which is worse than the spam from failing open.
    return true
  }
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
  // Idempotent: if a window already exists, focus it rather than creating a
  // second (orphaned) one. Guards against multiple callers (startApp, activate,
  // second-instance) racing during cold start.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return
  }

  mainWindow = new BrowserWindow({
    width: 1280,
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
    // Only show a native menu for editable fields (e.g. the message composer). Non-editable
    // elements use their own in-renderer Radix context menus, so we leave them alone.
    if (!params.isEditable) return

    const menu = new Menu()

    // Spellcheck suggestions for the misspelled word under the cursor, if any.
    if (params.misspelledWord) {
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
      menu.append(new MenuItem({ type: 'separator' }))
    }

    // Standard editing roles — Electron wires these to the focused field and applies the
    // correct enabled state from params.editFlags.
    const { editFlags } = params
    menu.append(new MenuItem({ role: 'cut', enabled: editFlags.canCut }))
    menu.append(new MenuItem({ role: 'copy', enabled: editFlags.canCopy }))
    menu.append(new MenuItem({ role: 'paste', enabled: editFlags.canPaste }))
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(new MenuItem({ role: 'selectAll', enabled: editFlags.canSelectAll }))

    menu.popup()
  })

  // Handle window.open() calls - deny popups and route external links / downloads.
  // installPopupHandler routes external URLs through safeOpenExternal (scheme
  // validation — SUP-214) and is shared with the dashboard popout (SUP-219).
  installPopupHandler(mainWindow.webContents)

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

  // Initialize the actual updater in production builds, or in dev when the
  // SUPERAGENT_TEST_UPDATES=1 escape hatch is set (see auto-updater.ts).
  if (!process.env.ELECTRON_RENDERER_URL || process.env.SUPERAGENT_TEST_UPDATES === '1') {
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

  // Emit maximize state so the custom Windows title-bar controls can toggle their icon
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window-maximized-change', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window-maximized-change', false)
  })

  // Browser-style hardware buttons (e.g. mouse Back/Forward) arrive as app
  // commands on Windows/Linux. Forward them to the renderer so TanStack Router's
  // history, not Electron's document history, owns app navigation.
  mainWindow.on('app-command', (event, command) => {
    if (command === 'browser-backward') {
      event.preventDefault()
      mainWindow?.webContents.send('history-navigation-command', 'back')
    } else if (command === 'browser-forward') {
      event.preventDefault()
      mainWindow?.webContents.send('history-navigation-command', 'forward')
    }
  })

  processPendingProtocolUrls()
}

// IPC handler for getting full screen state
ipcMain.handle('get-fullscreen-state', () => {
  return mainWindow?.isFullScreen() ?? false
})

// Custom Windows title-bar controls (Windows uses titleBarStyle: 'hidden' without overlay,
// so we draw our own buttons in the renderer and drive them via these IPCs).
ipcMain.on('window-minimize', () => {
  mainWindow?.minimize()
})
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on('window-close', () => {
  mainWindow?.close()
})
ipcMain.handle('get-window-maximized-state', () => {
  return mainWindow?.isMaximized() ?? false
})

// Reposition macOS traffic-light buttons to vertically center them in the
// 48px top bar when the sidebar is collapsed (no sidebar header to align with).
ipcMain.on('set-sidebar-collapsed', (_event, collapsed: boolean) => {
  if (process.platform !== 'darwin' || !mainWindow) return
  const y = collapsed ? 23 : 16
  const x = collapsed ? 21 : 16
  mainWindow.setWindowButtonPosition({ x, y })
})

// IPC handler for getting the API URL (port may vary)
ipcMain.handle('get-api-url', () => {
  return `http://localhost:${actualApiPort}`
})

// IPC handler for opening URLs in system browser. Renderer-supplied strings are
// scheme-validated before reaching the OS shell so a hostile/agent-controlled URL
// can't launch local apps or privileged handlers (file:/javascript:/custom) (SUP-214).
// First-party app UI also opens well-defined OS deep-links here (sms:/tel: for the
// iMessage setup link, x-apple.systempreferences: for the computer-use permission
// helper), so this path uses the slightly broader app allowlist; the popup handler
// above stays strict (web-only) since it fires for untrusted content.
ipcMain.handle('open-external', async (_event, url: string) => {
  await safeOpenExternalFromApp(url)
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

// IPC handler for keep-awake (macOS lid-close sleep prevention)
ipcMain.handle('set-keep-awake', async (_event, enabled: boolean) => {
  if (enabled) {
    await enableKeepAwake()
  } else {
    await disableKeepAwake()
  }
})

// IPC handler for showing OS notifications.
// `actions` and `context` are optional — when present, action buttons are
// rendered (macOS only via Electron's NotificationAction support; Windows /
// Linux ignore the array). The renderer receives `notification-action` events
// for clicks/actions and dispatches based on `context`.
ipcMain.handle('show-notification', (
  event,
  { title, body, actions, context }: {
    title: string
    body: string
    actions?: Array<{ text: string }>
    context?: unknown
  },
) => {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title,
    body,
    ...(actions && actions.length > 0
      ? { actions: actions.map((a) => ({ type: 'button' as const, text: a.text })) }
      : {}),
  })
  notification.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
      // If the notification carries agent/session context, navigate there
      // so the click lands on the conversation that needs attention rather
      // than dumping the user on the homepage.
      const ctx = context as { agentSlug?: string; sessionId?: string | null } | undefined
      if (ctx?.agentSlug) {
        mainWindow.webContents.send('navigate-to-agent', ctx.agentSlug, ctx.sessionId ?? null)
      }
    }
    event.sender.send('notification-event', { type: 'click', context })
  })
  notification.on('action', (_e, index) => {
    event.sender.send('notification-event', { type: 'action', actionIndex: index, context })
  })
  notification.on('close', () => {
    liveNotifications.delete(notification)
  })
  // Track by reviewId if this is a proxy-review notification, so the SSE
  // 'proxy_review_resolved' handler can dismiss it later.
  const ctxForTrack = context as { kind?: string; reviewId?: string } | undefined
  const reviewId =
    ctxForTrack?.kind === 'proxy_review' && typeof ctxForTrack.reviewId === 'string'
      ? ctxForTrack.reviewId
      : undefined
  trackLiveNotification(notification, reviewId)
  notification.show()
})

// Renderer pulls queued click/action events that were captured while the
// window was closed (notifications shown by the main-process SSE fallback).
// Returns and clears both queues atomically.
ipcMain.handle('flush-pending-notification-events', () => {
  const events = pendingNotificationEvents.splice(0, pendingNotificationEvents.length)
  const navigations = pendingNotificationNavigations.splice(
    0,
    pendingNotificationNavigations.length,
  )
  return { events, navigations }
})

// Renderer pulls menu commands (navigate-to-agent / open-settings /
// open-create-agent) that fired while the window was closed and recreated it.
// The renderer asks once on mount, when its IPC listeners are guaranteed
// attached, so no command is lost to the webContents.send race (SUP-264).
ipcMain.handle('flush-pending-menu-commands', () => {
  return flushPendingMenuCommands()
})

// --- Quick-dispatch launcher IPC ---

// Dispatched an agent from the launcher: hide the panel and raise the main
// window on the brand-new session so the user can watch it work.
ipcMain.on('quick-dispatch:dispatched', (_event, payload: { agentSlug: string; sessionId: string }) => {
  hideQuickDispatchWindow()
  focusMainWindowOnSession(payload.agentSlug, payload.sessionId)
})

// Esc / explicit dismiss from the launcher.
ipcMain.on('quick-dispatch:close', () => {
  hideQuickDispatchWindow()
})

// The launcher reports its measured content height so the frameless panel can
// hug its contents (and grow when a dropdown opens).
ipcMain.on('quick-dispatch:resize', (_event, height: number) => {
  if (typeof height === 'number' && Number.isFinite(height)) {
    setQuickDispatchContentHeight(height)
  }
})

// Suppress the blur-to-hide while a native picker (file/folder dialog) is open.
ipcMain.on('quick-dispatch:set-modal', (_event, open: boolean) => {
  setQuickDispatchModal(!!open)
})

// JS window drag (the frameless panel can't use a CSS drag region — that's inert
// to file drops). The renderer streams cursor deltas; we reposition the window.
ipcMain.on('quick-dispatch:drag-start', () => {
  startQuickDispatchDrag()
})
ipcMain.on('quick-dispatch:drag-move', (_event, delta: { dx: number; dy: number }) => {
  if (delta && Number.isFinite(delta.dx) && Number.isFinite(delta.dy)) {
    moveQuickDispatchDrag(delta.dx, delta.dy)
  }
})
ipcMain.on('quick-dispatch:drag-end', () => {
  endQuickDispatchDrag()
})

// "Set up voice input" from the launcher's mic button → open the main window's
// settings (the launcher itself has no settings surface).
ipcMain.on('quick-dispatch:open-settings', () => {
  hideQuickDispatchWindow()
  showOrCreateMainWindow()
  sendToMainWindowWhenReady((win) => win.webContents.send('open-settings'))
})

// Live re-bind the global shortcut after the user changes it in Settings.
// Returns the registration result so the UI can surface a conflict.
ipcMain.handle('set-global-dispatch-shortcut', (_event, accelerator: string) => {
  return registerGlobalDispatchShortcut(accelerator, toggleQuickDispatchWindow)
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

// IPC handler for revealing a path in the OS file manager.
// Only directories are allowed — `shell.openPath` would otherwise launch files
// with their default app (e.g. .app bundles, .command scripts, .exe).
ipcMain.handle('show-in-folder', async (_event, rawPath: unknown) => {
  const hostPath = ShowInFolderPath.parse(rawPath)
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(hostPath)
  } catch (err) {
    return (err as NodeJS.ErrnoException).message
  }
  if (!stat.isDirectory()) {
    return `Not a directory: ${hostPath}`
  }
  const errorMessage = await shell.openPath(hostPath)
  return errorMessage === '' ? null : errorMessage
})

// --- Recent files infrastructure ---

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain',
  '.json': 'application/json', '.html': 'text/html', '.xml': 'text/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.zip': 'application/zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

// Track paths returned by get-recent-files so read-local-file can validate (#1 security)
const allowedRecentPaths = new Set<string>()
// Paths the user explicitly opened via the OS (dock drop / "Open With"). Kept
// separate because get-recent-files clears allowedRecentPaths on every call —
// that must not evict a just-opened file before the launcher reads it.
const explicitlyOpenedPaths = new Set<string>()

function sanitizeLimit(raw: unknown): number {
  const n = Math.floor(Number(raw) || 5)
  return Math.min(Math.max(n, 1), 20)
}

// IPC handler for getting recent files from the OS
ipcMain.handle('get-recent-files', async (_event, rawLimit: unknown): Promise<{ name: string; path: string; thumbnail?: string }[]> => {
  const limit = sanitizeLimit(rawLimit)
  try {
    let files: { name: string; path: string }[]
    if (process.platform === 'win32') {
      files = await getRecentFilesWindows(limit)
    } else if (process.platform === 'darwin') {
      files = await getRecentFilesMac(limit)
    } else {
      return []
    }

    // Update the allowlist for read-local-file
    allowedRecentPaths.clear()
    for (const f of files) allowedRecentPaths.add(f.path)

    // Generate small thumbnails for image files using Electron's nativeImage
    return files.map((f) => {
      const ext = path.extname(f.name).toLowerCase()
      if (!IMAGE_EXTS.has(ext)) return f
      try {
        const img = nativeImage.createFromPath(f.path)
        if (img.isEmpty()) return f
        // Only constrain width — let height scale to preserve aspect ratio (#4)
        const resized = img.resize({ width: 32, quality: 'good' })
        const png = resized.toPNG()
        return { ...f, thumbnail: `data:image/png;base64,${png.toString('base64')}` }
      } catch {
        return f
      }
    })
  } catch (err) {
    console.error('Failed to get recent files:', err)
    return []
  }
})

function getRecentFilesWindows(limit: number): Promise<{ name: string; path: string }[]> {
  return new Promise((resolve) => {
    const safeLimit = limit // already sanitized by caller
    const script = [
      '$shell = New-Object -ComObject WScript.Shell',
      '$recent = [Environment]::GetFolderPath("Recent")',
      '$results = @()',
      `foreach ($f in (Get-ChildItem $recent -Filter '*.lnk' | Sort-Object LastWriteTime -Descending | Select-Object -First 50)) {`,
      '  try {',
      '    $sc = $shell.CreateShortcut($f.FullName)',
      '    $target = $sc.TargetPath',
      '    if ($target -and (Test-Path $target -PathType Leaf -ErrorAction SilentlyContinue)) {',
      '      $results += @{ name = [System.IO.Path]::GetFileName($target); path = $target }',
      '    }',
      '  } catch {}',
      `  if ($results.Count -ge ${safeLimit}) { break }`,
      '}',
      '$results | ConvertTo-Json -Compress',
    ].join('\r\n')

    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    exec(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([])
      try {
        const parsed = JSON.parse(stdout.trim())
        resolve(Array.isArray(parsed) ? parsed : [parsed])
      } catch {
        resolve([])
      }
    })
  })
}

function getRecentFilesMac(limit: number): Promise<{ name: string; path: string }[]> {
  return new Promise((resolve) => {
    // Use mdfind with sort by last used date (#2 — sort by recency)
    const safeLimit = limit * 3 // fetch more than needed since some may be dirs/inaccessible
    exec(
      `mdfind -onlyin "$HOME" 'kMDItemLastUsedDate > $time.now(-7d) && kMDItemContentTypeTree == "public.content"' | head -${safeLimit}`,
      { timeout: 5000 },
      async (err, stdout) => {
        if (err || !stdout.trim()) return resolve([])
        const lines = stdout.trim().split('\n').filter(Boolean)

        // Get last-used dates via mdls and sort by recency (#2)
        const withDates: { filePath: string; mtime: number }[] = []
        await Promise.all(lines.map((filePath) =>
          fs.promises.stat(filePath).then((stat) => {
            if (stat.isFile()) {
              withDates.push({ filePath, mtime: stat.mtimeMs })
            }
          }).catch(() => {})
        ))
        withDates.sort((a, b) => b.mtime - a.mtime)

        resolve(withDates.slice(0, limit).map((f) => ({
          name: path.basename(f.filePath),
          path: f.filePath,
        })))
      },
    )
  })
}

// IPC handler for reading a local file as a buffer (used by recent files picker)
ipcMain.handle('read-local-file', async (_event, filePath: string): Promise<{ buffer: ArrayBuffer; name: string; type: string } | null> => {
  // Security: only allow reading files the user surfaced to us — either via
  // get-recent-files (#1) or by explicitly opening them with the app.
  if (!allowedRecentPaths.has(filePath) && !explicitlyOpenedPaths.has(filePath)) {
    console.warn('read-local-file: path not in allowed recent files:', filePath)
    return null
  }
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) return null
    const buffer = await fs.promises.readFile(filePath)
    const name = path.basename(filePath)
    const ext = path.extname(name).toLowerCase()
    return { buffer: buffer.buffer, name, type: MIME_TYPES[ext] || 'application/octet-stream' }
  } catch {
    return null
  }
})

// IPC handler for showing the native emoji picker (macOS/Windows)
ipcMain.handle('show-emoji-panel', () => {
  app.showEmojiPanel()
})

// IPC handler for opening a dashboard in a separate window
ipcMain.handle('open-dashboard-window', (_event, { agentSlug, dashboardSlug }: { agentSlug: string; dashboardSlug: string }) => {
  openDashboardWindow(agentSlug, dashboardSlug, actualApiPort)
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

  // Windows uses titleBarStyle: 'hidden' WITHOUT a native overlay (see window
  // creation above) and draws its own title-bar buttons in the renderer, which
  // recolor via CSS. Calling setTitleBarOverlay here would throw
  // "Titlebar overlay is not enabled", so there is nothing native to recolor.
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

  // Agent deep link — navigate to the agent and select its latest session when available.
  if (url.startsWith(`${PROTOCOL_SCHEME}://agent/`)) {
    try {
      const slug = decodeURIComponent(url.replace(`${PROTOCOL_SCHEME}://agent/`, '').split('/')[0])
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        fetch(`http://localhost:${actualApiPort}/api/agents/${slug}/sessions`)
          .then(res => res.ok ? res.json() : [])
          .then((sessions: Array<{ id: string; isActive: boolean; updatedAt?: string }>) => {
            const active = sessions.find(s => s.isActive)
            const latest = active ?? sessions[0]
            mainWindow!.webContents.send('navigate-to-agent', slug, latest?.id ?? null)
          })
          .catch(() => {
            mainWindow!.webContents.send('navigate-to-agent', slug, null)
          })
      }
    } catch (error) {
      console.error('Failed to navigate to agent from deep link:', error)
    }
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
        openDashboardWindow(agentSlug, dashboardSlug, actualApiPort)
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
        // Composio's /link flow may use either casing — accept both.
        connectionId:
          callbackUrl.searchParams.get('connectedAccountId') ||
          callbackUrl.searchParams.get('connected_account_id'),
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
      const label = callbackUrl.searchParams.get('label') || 'Gamut'
      const orgId = callbackUrl.searchParams.get('org_id')
      const orgName = callbackUrl.searchParams.get('org_name')
      const role = callbackUrl.searchParams.get('role')
      const userId = callbackUrl.searchParams.get('user_id')
      const memberId = callbackUrl.searchParams.get('member_id')
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
          orgId,
          orgName,
          role,
          userId,
          memberId,
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

      // Dismiss any in-flight OS notification for a resolved review so it
      // doesn't sit in Notification Center inviting stale Approve/Deny
      // clicks (review S8). This mirrors the renderer-side query
      // invalidation and works for dismissal regardless of window state.
      if (data.type === 'session_awaiting_input' && data.review?.type === 'proxy_review_resolved') {
        const rid = data.review.reviewId
        if (typeof rid === 'string') dismissReviewNotification(rid)
      }

      if (data.type === 'os_notification') {
        // Only show notification if window is closed/destroyed.
        // When the window is open the renderer drives this via IPC (with the
        // shared show-notification handler that supports actions + click
        // navigation). Here we mirror that behavior so a closed window
        // doesn't lose action buttons or session-aware click routing.
        //
        // Respect the local user's notification settings the same way the
        // renderer does — without this, users who disabled session_waiting
        // notifications still get them when the window is closed (review
        // S10). Note: this is the local user's settings only. In multi-user
        // auth mode the SSE stream consumed by main isn't user-scoped, so
        // cross-user filtering happens server-side via getAccessibleAgentSlugs
        // (notifications.ts) — see review S9.
        const notificationType = data.notificationType as string | undefined
        if (
          (!mainWindow || mainWindow.isDestroyed()) &&
          isNotificationTypeAllowedLocally(notificationType) &&
          Notification.isSupported()
        ) {
          const actions = data.actions as Array<{ text: string }> | undefined
          const context = data.actionContext as
            | { agentSlug?: string; sessionId?: string | null; kind?: string; reviewId?: string }
            | undefined
          const notification = new Notification({
            title: data.title,
            body: data.body,
            ...(actions && actions.length > 0
              ? {
                  actions: actions.map((a) => ({
                    type: 'button' as const,
                    text: a.text,
                  })),
                }
              : {}),
          })
          notification.on('click', () => {
            // Queue navigation so the renderer routes the user to the
            // right session on mount. Also queue the click event itself
            // so the dispatcher can mark the DB notification as read —
            // the renderer's mark-read path keys on context.notificationId.
            if (context?.agentSlug) {
              pushPendingNavigation({
                agentSlug: context.agentSlug,
                sessionId: context.sessionId ?? null,
              })
            }
            pushPendingNotificationEvent({ type: 'click', context })
            if (!mainWindow || mainWindow.isDestroyed()) {
              app.emit('activate')
            } else {
              mainWindow.show()
              mainWindow.focus()
            }
          })
          notification.on('action', (_e, index) => {
            pushPendingNotificationEvent({
              type: 'action',
              actionIndex: index,
              context,
            })
            if (!mainWindow || mainWindow.isDestroyed()) {
              app.emit('activate')
            }
          })
          notification.on('close', () => {
            liveNotifications.delete(notification)
          })
          const reviewId =
            context?.kind === 'proxy_review' && typeof context.reviewId === 'string'
              ? context.reviewId
              : undefined
          trackLiveNotification(notification, reviewId)
          notification.show()
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
  // Bind the API server atomically, retrying on a port race until a port is
  // claimed (no probe-then-bind TOCTOU gap; an EADDRINUSE retries instead of
  // crashing the app via uncaughtException). See bindServerWithRetry.
  let boundPort: number
  try {
    const bound = await bindServerWithRetry(api.fetch, {
      startPort: DEFAULT_API_PORT,
      hostname: '0.0.0.0',
    })
    apiServer = bound.server
    // Record the port everyone else reads (createAppMenu, createTray, the
    // renderer base URL, etc.). A stale value here points the UI at a dead
    // server, so update both the module state and process.env.PORT.
    actualApiPort = bound.port
    process.env.PORT = String(bound.port)
    boundPort = bound.port
    // Wire server-level handlers (WebSocket proxies, etc.) on the bound server.
    setupServerHandlers(bound.server)
    console.log(`API server running on http://localhost:${bound.port}`)
  } catch (error) {
    console.error('Failed to bind API server:', error)
    app.quit()
    return
  }

  // Initialize all background services
  initializeServices().catch((error) => {
    console.error('Failed to initialize services:', error)
  })

  // Reconnect chat integrations after system sleep
  powerMonitor.on('resume', () => {
    chatIntegrationManager.reconnectAll().catch((err) => {
      console.error('Failed to reconnect chat integrations after resume:', err)
    })
  })

  // Start listening for notifications (for when window is closed)
  startNotificationListener()

  // Mark API as ready and process any queued dashboard deep links
  apiReady = true
  for (const link of pendingDashboardLinks) {
    openDashboardWindow(link.agentSlug, link.dashboardSlug, actualApiPort)
  }
  pendingDashboardLinks.length = 0
  processPendingProtocolUrls()

  // Wait for app to be ready, then create window. Window/menu/tray creation is
  // deferred until here so they're never built against a port that never bound.
  await app.whenReady()

  createWindow()

  // Create the application menu (macOS menu bar)
  createAppMenu(mainWindow, boundPort)

  // Create system tray if enabled in settings
  const settings = getSettings()
  if (settings.app?.showMenuBarIcon !== false) {
    createTray(mainWindow, boundPort)
  }

  // Restore keep-awake state from previous session (after window is ready so dialogs display correctly)
  const userSettings = getUserSettings('local')
  restoreKeepAwakeOnStartup(userSettings.keepAwakeEnabled).catch((error) => {
    console.error('Failed to restore keep-awake state:', error)
  })

  // Quick-dispatch launcher: pre-create the hidden panel and bind its global
  // shortcut so the first invocation appears instantly.
  prewarmQuickDispatchWindow()
  const dispatchResult = registerGlobalDispatchShortcut(settings.app?.globalDispatchShortcut, toggleQuickDispatchWindow)
  if (!dispatchResult.success) {
    console.warn(`Quick-dispatch shortcut not registered: ${dispatchResult.error}`)
  }
  // Windows/Linux "Open With" / drag-onto-exe / CLI file args come in on THIS
  // launch's command line (macOS uses open-file). Queue them before the flush.
  for (const filePath of openedFilesFrom(process.argv)) {
    handleOpenedFile(filePath)
  }
  // The launcher window now exists, so any files opened before startup finished
  // (dock drop on macOS, argv above) can be delivered to it.
  flushPendingOpenedFiles()
}

// App lifecycle - handle activate separately
// Show the main window, recreating it if it was closed (window stays in tray
// after close on macOS/Windows, so `mainWindow` may be null/destroyed here).
function showOrCreateMainWindow() {
  // During the first instance's cold start the window doesn't exist yet, but
  // startApp() will create and show it momentarily — don't race it. (A queued
  // deep-link URL, if any, is handled separately by handleDeepLinkUrl.)
  if (!app.isReady()) return

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    // Update tray, menu, and auto-updater with new window reference
    updateTrayWindow(mainWindow)
    updateAppMenuWindow(mainWindow)
    updateAutoUpdaterWindow(mainWindow)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// Run `fn` against the main window once its renderer is ready to receive IPC.
// If the window was just (re)created its listeners aren't mounted yet, so the
// send would be lost — wait for the load and give React a beat to subscribe.
function sendToMainWindowWhenReady(fn: (win: BrowserWindow) => void): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) fn(mainWindow)
    }, 300))
  } else {
    fn(win)
  }
}

// Raise the main window and route it to a specific session. Reuses the same
// 'navigate-to-agent' channel the tray/notifications use (MenuCommandHandler).
function focusMainWindowOnSession(agentSlug: string, sessionId: string): void {
  showOrCreateMainWindow()
  sendToMainWindowWhenReady((win) =>
    win.webContents.send('navigate-to-agent', agentSlug, sessionId),
  )
}

app.whenReady().then(() => {

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    showOrCreateMainWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS and Windows, keep app running in the background (system tray)
  // On Linux, quit when all windows are closed
  if (process.platform === 'linux') {
    app.quit()
  }
})

// Files opened with the app arrive differently per OS: macOS fires `open-file`
// (dock drop / "Open With"), while Windows/Linux pass the paths as argv (on a
// cold launch AND, for an already-running instance, via `second-instance`). Both
// funnel into handleOpenedFile, which opens the launcher with the file attached.
// open-file can fire before `ready` (cold launch by dropping a file), so paths
// queue until the launcher window has been pre-warmed. Registered at module
// scope so it's live before `ready`, per Electron's guidance.
const pendingOpenedFiles: string[] = []
let quickDispatchReadyForFiles = false

// Resolve real file paths from a process command line (the Windows/Linux path),
// wiring the pure helper to Electron/fs. No-op on macOS and in dev builds.
function openedFilesFrom(commandLine: string[], workingDirectory?: string): string[] {
  return filesFromCommandLine(commandLine, {
    platform: process.platform,
    isPackaged: app.isPackaged,
    protocolScheme: PROTOCOL_SCHEME,
    workingDirectory: workingDirectory || process.cwd(),
    fileExists: (p) => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    },
  })
}

function handleOpenedFile(filePath: string): void {
  // Authorize this exact path for `read-local-file`: the user explicitly opened
  // it with the app (dock drop / "Open With"), so the launcher renderer is
  // allowed to read it. Kept in a dedicated set that get-recent-files never
  // clears, so opening the Attach menu can't evict it before the drain reads it.
  explicitlyOpenedPaths.add(filePath)
  if (!quickDispatchReadyForFiles) {
    pendingOpenedFiles.push(filePath)
    return
  }
  openQuickDispatchWithFile(filePath)
}

// Renderer drains queued dock-drop / "Open With" files (pull, race-free).
ipcMain.handle('quick-dispatch:drain-attach', () => drainQuickDispatchAttachPaths())

function flushPendingOpenedFiles(): void {
  quickDispatchReadyForFiles = true
  while (pendingOpenedFiles.length > 0) {
    const filePath = pendingOpenedFiles.shift()
    if (filePath) openQuickDispatchWithFile(filePath)
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  handleOpenedFile(filePath)
})

// Single-instance handling (must run BEFORE startApp). When the app is already
// running in the tray and the user re-launches it (e.g. from the Start menu), a
// second process spawns. It MUST bail out immediately — if it falls through to
// startApp() it boots its own API server and briefly shows a window before the
// quit lands, which is the "ghost window" flash on re-launch.
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Exit hard without running startApp() or the before-quit graceful-shutdown
  // dance — this process never initialized anything, so there's nothing to clean
  // up and nothing should ever become visible.
  app.exit(0)
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    // The re-launch landed here on the original instance. Surface its window —
    // recreating it if it was closed to the tray — otherwise a plain re-launch
    // does nothing visible.
    showOrCreateMainWindow()

    // Handle protocol URLs on Windows/Linux
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`))
    if (url) {
      handleDeepLinkUrl(url)
    }

    // Files "Open With"-ed / dropped on the exe while already running arrive as
    // the re-launch's argv → open the launcher with them attached (Windows/Linux).
    for (const filePath of openedFilesFrom(commandLine, workingDirectory)) {
      handleOpenedFile(filePath)
    }
  })

  // Only the instance that holds the lock boots the app.
  startApp()
}

// Graceful shutdown handling
let isShuttingDown = false

async function gracefulShutdown() {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('Shutting down gracefully...')

  // Restore system sleep settings (best-effort, no sudo prompt)
  cleanupKeepAwake()

  // Stop notification listener
  stopNotificationListener()

  // Close all dashboard windows
  closeAllDashboardWindows()

  // Tear down the quick-dispatch launcher and release its global shortcut.
  unregisterGlobalDispatchShortcut()
  closeQuickDispatchWindow()

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
    // Defer app.quit() by one tick. When launched via `electron-vite dev`, calling
    // app.quit() synchronously after a preventDefault'd before-quit fails to reach
    // [NSApp terminate:] on macOS — the process hangs in AppKit's idle event loop.
    // Does NOT reproduce when Electron is launched directly (without electron-vite),
    // so the trigger is something electron-vite does to the Electron child process.
    // See alex8088/electron-vite#899 for the upstream bug (repro + A/B control).
    setImmediate(() => app.quit())
  }
})

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error)
  captureException(error, { tags: { type: 'uncaughtException' }, level: 'fatal' })
  await flushErrorReporting(3000)
  await gracefulShutdown()
  // See before-quit handler above for why this is deferred
  setImmediate(() => app.quit())
})

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason)
  captureException(reason instanceof Error ? reason : new Error(String(reason)), { tags: { type: 'unhandledRejection' }, level: 'fatal' })
  await flushErrorReporting(3000)
  await gracefulShutdown()
  // See before-quit handler above for why this is deferred
  setImmediate(() => app.quit())
})
