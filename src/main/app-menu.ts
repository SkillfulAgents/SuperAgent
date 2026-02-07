import { Menu, BrowserWindow, app, nativeImage } from 'electron'
import path from 'path'
import { fetchAgentsWithStatus, ActivityStatus } from './agent-status'

let mainWindowRef: BrowserWindow | null = null
let apiPortRef: number = 0
let updateInterval: NodeJS.Timeout | null = null

/**
 * Create a status icon from file
 */
function createStatusIcon(status: ActivityStatus): Electron.NativeImage {
  const iconPath = path.join(__dirname, `../../build/status_${status}.png`)
  return nativeImage.createFromPath(iconPath)
}

/**
 * Send an IPC event to the renderer, ensuring the window exists
 */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    app.emit('activate')
    // Can't send yet - window doesn't exist
    return
  }
  mainWindowRef.show()
  mainWindowRef.focus()
  mainWindowRef.webContents.send(channel, ...args)
}

/**
 * Build and set the application menu
 */
async function buildAppMenu(): Promise<void> {
  const agents = await fetchAgentsWithStatus(apiPortRef)

  // Group agents by status
  const working = agents.filter(a => a.activityStatus === 'working')
  const idle = agents.filter(a => a.activityStatus === 'idle')
  const sleeping = agents.filter(a => a.activityStatus === 'sleeping')

  // Build Agents submenu
  const agentsSubmenu: Electron.MenuItemConstructorOptions[] = []

  if (working.length > 0) {
    agentsSubmenu.push({ label: 'Working', enabled: false })
    working.forEach(agent => {
      agentsSubmenu.push({
        label: agent.name,
        icon: createStatusIcon('working'),
        click: () => sendToRenderer('navigate-to-agent', agent.slug),
      })
    })
    agentsSubmenu.push({ type: 'separator' })
  }

  if (idle.length > 0) {
    agentsSubmenu.push({ label: 'Idle', enabled: false })
    idle.forEach(agent => {
      agentsSubmenu.push({
        label: agent.name,
        icon: createStatusIcon('idle'),
        click: () => sendToRenderer('navigate-to-agent', agent.slug),
      })
    })
    agentsSubmenu.push({ type: 'separator' })
  }

  if (sleeping.length > 0) {
    agentsSubmenu.push({ label: 'Sleeping', enabled: false })
    sleeping.forEach(agent => {
      agentsSubmenu.push({
        label: agent.name,
        icon: createStatusIcon('sleeping'),
        click: () => sendToRenderer('navigate-to-agent', agent.slug),
      })
    })
  }

  if (agents.length === 0) {
    agentsSubmenu.push({ label: 'No agents', enabled: false })
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS uses the app name automatically)
    {
      label: 'SuperAgent',
      submenu: [
        { role: 'about', label: 'About SuperAgent' },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToRenderer('open-settings'),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Agent',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToRenderer('open-create-agent'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    // Edit menu (needed for standard text editing shortcuts)
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // Agents menu
    {
      label: 'Agents',
      submenu: agentsSubmenu,
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

/**
 * Create the application menu and start periodic updates
 */
export function createAppMenu(
  mainWindow: BrowserWindow | null,
  apiPort: number
): void {
  mainWindowRef = mainWindow
  apiPortRef = apiPort

  // Initial build
  buildAppMenu()

  // Update periodically to refresh agent list (every 30s, same as tray)
  updateInterval = setInterval(() => {
    buildAppMenu()
  }, 30000)
}

/**
 * Update the main window reference (e.g., after window recreation)
 */
export function updateAppMenuWindow(mainWindow: BrowserWindow | null): void {
  mainWindowRef = mainWindow
}

/**
 * Clean up the app menu update interval
 */
export function destroyAppMenu(): void {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
}
