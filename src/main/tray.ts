import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import path from 'path'
import { fetchAgentsWithStatus, ActivityStatus, AgentInfo } from './agent-status'

let tray: Tray | null = null
let updateInterval: NodeJS.Timeout | null = null
let mainWindowRef: BrowserWindow | null = null
let apiPortRef: number = 0

/**
 * Create the system tray with menu
 */
export function createTray(
  mainWindow: BrowserWindow | null,
  apiPort: number
): Tray {
  mainWindowRef = mainWindow
  apiPortRef = apiPort

  // Create programmatic template icon (black circle for macOS menu bar)
  const icon = createTrayIcon()

  tray = new Tray(icon)
  tray.setToolTip('Superagent')

  // On Windows, clicking the tray icon should show/focus the window
  if (process.platform === 'win32') {
    tray.on('click', () => showWindow())
  }

  // Initial menu build
  updateTrayMenu().catch((error) => {
    console.error('Failed to build tray menu:', error)
  })

  // Set up polling (every 30 seconds - container status is cached server-side)
  updateInterval = setInterval(() => {
    updateTrayMenu().catch((error) => {
      console.error('Failed to update tray menu:', error)
    })
  }, 30000)

  return tray
}

/**
 * Update the main window reference (e.g., after window recreation)
 */
export function updateTrayWindow(mainWindow: BrowserWindow | null): void {
  mainWindowRef = mainWindow
}

/**
 * Destroy the tray and clean up resources
 */
export function destroyTray(): void {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/**
 * Set tray visibility - creates or destroys tray as needed
 */
export function setTrayVisible(visible: boolean): void {
  if (visible && !tray) {
    // Create tray if it doesn't exist and we have the required refs
    if (apiPortRef > 0) {
      const icon = createTrayIcon()
      tray = new Tray(icon)
      tray.setToolTip('Superagent')

      // On Windows, clicking the tray icon should show/focus the window
      if (process.platform === 'win32') {
        tray.on('click', () => showWindow())
      }

      // Set initial simple menu, then update async
      const initialMenu = Menu.buildFromTemplate([
        { label: 'Open Superagent', click: () => showWindow() },
        { type: 'separator' },
        { label: 'Loading...', enabled: false },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
      tray.setContextMenu(initialMenu)

      // Update menu in background (don't await)
      updateTrayMenu().catch((error) => {
        console.error('Failed to build tray menu:', error)
      })

      // Set up polling (every 30 seconds - container status is cached server-side)
      if (!updateInterval) {
        updateInterval = setInterval(() => {
          updateTrayMenu().catch((error) => {
            console.error('Failed to update tray menu:', error)
          })
        }, 30000)
      }
    }
  } else if (!visible && tray) {
    // Destroy tray
    destroyTray()
  }
}

/**
 * Check if tray is currently visible
 */
export function isTrayVisible(): boolean {
  return tray !== null
}

/**
 * Get the directory containing tray/status icons.
 * In dev mode, icons are in the project's build/ directory.
 * In production, they are bundled as extraResources under tray-icons/.
 */
function getIconDir(): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    // Dev mode
    return path.join(__dirname, '../../build')
  }
  // Production — extraResources are in process.resourcesPath
  return path.join(process.resourcesPath, 'tray-icons')
}

/**
 * Create the tray icon from file.
 * On macOS, uses a template image (auto-inverts for light/dark menu bar).
 * On Windows/Linux, uses the app icon directly.
 */
function createTrayIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const iconPath = path.join(getIconDir(), 'trayTemplate.png')
    const icon = nativeImage.createFromPath(iconPath)
    icon.setTemplateImage(true)
    return icon
  }
  // Windows/Linux: use a dedicated high-res tray icon — the OS handles DPI scaling
  const iconPath = path.join(getIconDir(), 'trayIcon.png')
  return nativeImage.createFromPath(iconPath)
}

/**
 * Create a status icon from file.
 * Returns undefined when the icon cannot be loaded so callers can omit
 * the `icon` property rather than passing an empty NativeImage (which
 * causes Electron's Menu.buildFromTemplate to throw).
 */
function createStatusIcon(status: ActivityStatus): Electron.NativeImage | undefined {
  const iconPath = path.join(getIconDir(), `status_${status}.png`)
  const img = nativeImage.createFromPath(iconPath)
  return img.isEmpty() ? undefined : img
}


/**
 * Navigate to a specific agent in the app
 */
function navigateToAgent(agentSlug: string): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    // Window was closed - trigger recreation via activate
    app.emit('activate')
    // Store pending navigation to apply after window created
    // For now, just show the window - navigation will need manual click
    return
  }

  // Show and focus the window
  mainWindowRef.show()
  mainWindowRef.focus()

  // Send IPC message to renderer to navigate
  mainWindowRef.webContents.send('navigate-to-agent', agentSlug)
}

/**
 * Show and focus the main window
 */
function showWindow(): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    app.emit('activate')
    return
  }
  mainWindowRef.show()
  mainWindowRef.focus()
}

/**
 * Update the tray context menu with current agent data
 */
async function updateTrayMenu(): Promise<void> {
  if (!tray) return

  const agents = await fetchAgentsWithStatus(apiPortRef)

  // Group agents by status
  const awaitingInput = agents.filter(a => a.activityStatus === 'awaiting_input')
  const working = agents.filter(a => a.activityStatus === 'working')
  const idle = agents.filter(a => a.activityStatus === 'idle')
  const sleeping = agents.filter(a => a.activityStatus === 'sleeping')

  // Build menu template
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Open Superagent',
      click: () => showWindow(),
    },
    { type: 'separator' },
  ]

  const agentMenuItem = (agent: AgentInfo, status: ActivityStatus): Electron.MenuItemConstructorOptions => {
    const icon = createStatusIcon(status)
    return {
      label: agent.name,
      ...(icon && { icon }),
      click: () => navigateToAgent(agent.slug),
    }
  }

  if (awaitingInput.length > 0) {
    menuTemplate.push({ label: 'Awaiting Input', enabled: false })
    awaitingInput.forEach(agent => menuTemplate.push(agentMenuItem(agent, 'working')))
    menuTemplate.push({ type: 'separator' })
  }

  if (working.length > 0) {
    menuTemplate.push({ label: 'Working', enabled: false })
    working.forEach(agent => menuTemplate.push(agentMenuItem(agent, 'working')))
    menuTemplate.push({ type: 'separator' })
  }

  if (idle.length > 0) {
    menuTemplate.push({ label: 'Idle', enabled: false })
    idle.forEach(agent => menuTemplate.push(agentMenuItem(agent, 'idle')))
    menuTemplate.push({ type: 'separator' })
  }

  if (sleeping.length > 0) {
    menuTemplate.push({ label: 'Sleeping', enabled: false })
    sleeping.forEach(agent => menuTemplate.push(agentMenuItem(agent, 'sleeping')))
    menuTemplate.push({ type: 'separator' })
  }

  // No agents state
  if (agents.length === 0) {
    menuTemplate.push({ label: 'No agents', enabled: false })
    menuTemplate.push({ type: 'separator' })
  }

  // Quit option
  menuTemplate.push({
    label: 'Quit',
    click: () => app.quit(),
  })

  // Check again after async operations in case tray was destroyed during quit
  if (!tray) return

  const contextMenu = Menu.buildFromTemplate(menuTemplate)
  tray.setContextMenu(contextMenu)
}
