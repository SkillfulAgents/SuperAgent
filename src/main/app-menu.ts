import { Menu, BrowserWindow, app, nativeImage } from 'electron'
import path from 'path'
import type { ApiTarget } from '@shared/lib/api-target'
import { fetchAgentsWithStatus, ActivityStatus } from './agent-status'
import { openFindBar } from './find-in-page'

let mainWindowRef: BrowserWindow | null = null
// A getter rather than a stored URL: in cloud mode the effective base is the
// keyed proxy prefix, and which one is in force can change on a target switch.
let getApiBaseUrlRef: (() => string) | null = null
let updateInterval: NodeJS.Timeout | null = null

/**
 * Menu commands that fired while the window was closed (app still in the
 * tray/dock on macOS/Windows) are queued here and pulled by the renderer on
 * mount via the `flush-pending-menu-commands` IPC, mirroring the notification
 * queue in index.ts. Without this, recreating the window from a menu click
 * (File > Settings, Agents > <name>, New Agent) races the renderer's useEffect
 * listeners: `webContents.send` fires before they attach, the command is lost,
 * and the window opens but never navigates (SUP-264).
 */
export type PendingMenuCommand =
  | { channel: 'navigate-to-agent'; agentSlug: string; sessionId?: string | null }
  | { channel: 'open-settings' }
  | { channel: 'open-create-agent' }
  | { channel: 'switch-target'; target: ApiTarget }

const pendingMenuCommands: PendingMenuCommand[] = []

/** The arguments a command's live IPC event carries, after its channel. */
function ipcArgs(command: PendingMenuCommand): unknown[] {
  switch (command.channel) {
    case 'navigate-to-agent':
      return [command.agentSlug, command.sessionId ?? null]
    case 'switch-target':
      return [command.target]
    case 'open-settings':
    case 'open-create-agent':
      return []
  }
}

function queueMenuCommand(command: PendingMenuCommand): void {
  // Keep only the latest command per channel: replaying duplicates would open
  // several Settings dialogs or create several untitled agents, and only the
  // most recent navigate-to-agent target matters (last menu click wins). This
  // also bounds the queue to one entry per channel, so it can't grow unbounded
  // while the window stays closed.
  const existingIdx = pendingMenuCommands.findIndex(c => c.channel === command.channel)
  if (existingIdx !== -1) pendingMenuCommands.splice(existingIdx, 1)
  pendingMenuCommands.push(command)
}

/** Drain and return queued menu commands. The renderer pulls these on mount. */
export function flushPendingMenuCommands(): PendingMenuCommand[] {
  return pendingMenuCommands.splice(0, pendingMenuCommands.length)
}

/**
 * Get the directory containing status icons.
 * In dev mode, icons are in the project's build/ directory.
 * In production, they are bundled as extraResources under tray-icons/.
 */
function getIconDir(): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return path.join(__dirname, '../../build')
  }
  return path.join(process.resourcesPath, 'tray-icons')
}

/**
 * Create a status icon from file
 */
function createStatusIcon(status: ActivityStatus): Electron.NativeImage {
  const iconPath = path.join(getIconDir(), `status_${status}.png`)
  return nativeImage.createFromPath(iconPath)
}

/**
 * Deliver a command to the main window's renderer, ensuring the window exists:
 * live when it is listening, queued for its mount-time flush when the window is
 * closed or still loading. Used by the menu and by Spotlight results.
 */
export function sendMenuCommand(command: PendingMenuCommand): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    // Window closed (app still in tray/dock). Queue the command so the renderer
    // can replay it once it mounts, then recreate the window. Sending now would
    // be lost — the window doesn't exist yet (SUP-264).
    queueMenuCommand(command)
    app.emit('activate')
    return
  }

  mainWindowRef.show()
  mainWindowRef.focus()

  // Window exists but its renderer is still loading (e.g. a previous menu click
  // just recreated it). The IPC listeners attach on React mount, which hasn't
  // happened yet, so a live send would race them and be lost — queue instead
  // and let the mount-time flush deliver it.
  if (mainWindowRef.webContents.isLoading()) {
    queueMenuCommand(command)
    return
  }

  mainWindowRef.webContents.send(command.channel, ...ipcArgs(command))
}

/**
 * Builds overlap: the 30s poll and the target-switch refresh both come through
 * buildAppMenu, and the base URL is sampled before the await. Without this a
 * slow response from the previous target could land after the switch refresh
 * painted the new one and overwrite it. Last started wins.
 */
let buildGeneration = 0

/**
 * Build and set the application menu
 */
async function buildAppMenu(): Promise<void> {
  const generation = ++buildGeneration
  const agents = getApiBaseUrlRef ? await fetchAgentsWithStatus(getApiBaseUrlRef()) : []
  if (generation !== buildGeneration) return

  // Group agents by status
  const awaitingInput = agents.filter(a => a.activityStatus === 'awaiting_input')
  const working = agents.filter(a => a.activityStatus === 'working')
  const idle = agents.filter(a => a.activityStatus === 'idle')
  const sleeping = agents.filter(a => a.activityStatus === 'sleeping')

  // Build Agents submenu
  const agentsSubmenu: Electron.MenuItemConstructorOptions[] = []

  if (awaitingInput.length > 0) {
    agentsSubmenu.push({ label: 'Needs Input', enabled: false })
    awaitingInput.forEach(agent => {
      agentsSubmenu.push({
        label: agent.name,
        icon: createStatusIcon('working'),
        click: () => sendMenuCommand({ channel: 'navigate-to-agent', agentSlug: agent.slug }),
      })
    })
    agentsSubmenu.push({ type: 'separator' })
  }

  if (working.length > 0) {
    agentsSubmenu.push({ label: 'Working', enabled: false })
    working.forEach(agent => {
      agentsSubmenu.push({
        label: agent.name,
        icon: createStatusIcon('working'),
        click: () => sendMenuCommand({ channel: 'navigate-to-agent', agentSlug: agent.slug }),
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
        click: () => sendMenuCommand({ channel: 'navigate-to-agent', agentSlug: agent.slug }),
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
        click: () => sendMenuCommand({ channel: 'navigate-to-agent', agentSlug: agent.slug }),
      })
    })
  }

  if (agents.length === 0) {
    agentsSubmenu.push({ label: 'No agents', enabled: false })
  }

  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only — on macOS, the first menu becomes the "app" menu)
    ...(isMac ? [{
      label: 'Gamut',
      submenu: [
        { role: 'about' as const, label: 'About Gamut' },
        { type: 'separator' as const },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuCommand({ channel: 'open-settings' }),
        },
        { type: 'separator' as const },
        // Explicit labels: `role` items interpolate app.name (kept 'SuperAgent' for
        // data-dir / cookie-keychain continuity), which would otherwise leak the legacy
        // brand as "Hide SuperAgent" / "Quit SuperAgent" in the macOS app menu.
        { role: 'hide' as const, label: 'Hide Gamut' },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: 'Quit Gamut' },
      ],
    }] : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Agent',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuCommand({ channel: 'open-create-agent' }),
        },
        ...(!isMac ? [
          { type: 'separator' as const },
          {
            label: 'Settings...',
            accelerator: 'CmdOrCtrl+,',
            click: () => sendMenuCommand({ channel: 'open-settings' }),
          },
        ] : []),
        { type: 'separator' },
        ...(!isMac ? [{ role: 'quit' as const }] : [{ role: 'close' as const }]),
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
        { type: 'separator' },
        {
          label: 'Find…',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, window) => {
            if (window instanceof BrowserWindow) openFindBar(window)
          },
        },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
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
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
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
  getApiBaseUrl: () => string
): void {
  mainWindowRef = mainWindow
  getApiBaseUrlRef = getApiBaseUrl

  // Initial build
  refreshAppMenu()

  // Update periodically to refresh agent list (every 30s, same as tray)
  updateInterval = setInterval(() => {
    refreshAppMenu()
  }, 30000)
}

/**
 * Rebuild the menu now instead of waiting out the poll. Called on a target
 * switch, where the 30s interval would leave the previous Superagent's agents
 * in the Agents menu.
 */
export function refreshAppMenu(): void {
  buildAppMenu().catch((error) => {
    console.error('Failed to build app menu:', error)
  })
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
