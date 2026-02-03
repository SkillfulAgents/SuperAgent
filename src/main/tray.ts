import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import path from 'path'

// Types for internal use
interface ApiAgent {
  slug: string
  name: string
  status: 'running' | 'stopped'
}

interface ApiSession {
  id: string
  isActive: boolean
}

type ActivityStatus = 'working' | 'idle' | 'sleeping'

interface TrayAgentInfo {
  slug: string
  name: string
  activityStatus: ActivityStatus
}

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

  // Initial menu build
  updateTrayMenu()

  // Set up polling (every 5 seconds to match renderer polling)
  updateInterval = setInterval(() => {
    updateTrayMenu()
  }, 5000)

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
      updateTrayMenu()

      // Set up polling
      if (!updateInterval) {
        updateInterval = setInterval(() => {
          updateTrayMenu()
        }, 5000)
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
 * Create the tray icon from file
 */
function createTrayIcon(): Electron.NativeImage {
  // Use template image from build directory
  // Electron automatically picks up @2x version for Retina displays
  const iconPath = path.join(__dirname, '../../build/trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)
  return icon
}

/**
 * Create a status icon from file
 */
function createStatusIcon(status: ActivityStatus): Electron.NativeImage {
  const iconPath = path.join(__dirname, `../../build/status_${status}.png`)
  return nativeImage.createFromPath(iconPath)
}

/**
 * Fetch agents with their activity status from the API
 */
async function fetchAgentsWithStatus(): Promise<TrayAgentInfo[]> {
  try {
    // Fetch all agents
    const agentsRes = await fetch(`http://localhost:${apiPortRef}/api/agents`)
    if (!agentsRes.ok) return []
    const agents: ApiAgent[] = await agentsRes.json()

    // For each running agent, check if it has active sessions
    const agentsWithStatus: TrayAgentInfo[] = await Promise.all(
      agents.map(async (agent) => {
        let hasActiveSessions = false

        if (agent.status === 'running') {
          try {
            const sessionsRes = await fetch(
              `http://localhost:${apiPortRef}/api/agents/${agent.slug}/sessions`
            )
            if (sessionsRes.ok) {
              const sessions: ApiSession[] = await sessionsRes.json()
              hasActiveSessions = sessions.some(s => s.isActive)
            }
          } catch {
            // Ignore session fetch errors
          }
        }

        // Derive activity status (matches getAgentActivityStatus logic)
        let activityStatus: ActivityStatus
        if (agent.status === 'stopped') {
          activityStatus = 'sleeping'
        } else if (hasActiveSessions) {
          activityStatus = 'working'
        } else {
          activityStatus = 'idle'
        }

        return {
          slug: agent.slug,
          name: agent.name,
          activityStatus,
        }
      })
    )

    return agentsWithStatus
  } catch (error) {
    console.error('Failed to fetch agents for tray:', error)
    return []
  }
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

  const agents = await fetchAgentsWithStatus()

  // Group agents by status
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

  // Add working agents section
  if (working.length > 0) {
    menuTemplate.push({ label: 'Working', enabled: false })
    working.forEach(agent => {
      menuTemplate.push({
        label: agent.name,
        icon: createStatusIcon('working'),
        click: () => navigateToAgent(agent.slug),
      })
    })
    menuTemplate.push({ type: 'separator' })
  }

  // Add idle agents section
  if (idle.length > 0) {
    menuTemplate.push({ label: 'Idle', enabled: false })
    idle.forEach(agent => {
      menuTemplate.push({
        label: agent.name,
        icon: createStatusIcon('idle'),
        click: () => navigateToAgent(agent.slug),
      })
    })
    menuTemplate.push({ type: 'separator' })
  }

  // Add sleeping agents section
  if (sleeping.length > 0) {
    menuTemplate.push({ label: 'Sleeping', enabled: false })
    sleeping.forEach(agent => {
      menuTemplate.push({
        label: agent.name,
        icon: createStatusIcon('sleeping'),
        click: () => navigateToAgent(agent.slug),
      })
    })
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
