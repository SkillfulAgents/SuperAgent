import { BrowserWindow, shell, type WebContents } from 'electron'
import { buildDashboardViewUrl } from '@shared/lib/dashboard-url'

// Open dashboard popouts keyed by `${agentSlug}/${dashboardSlug}`. The raw join
// is fine as a dedup key — only the loaded URL needs per-segment encoding.
const dashboardWindows: Map<string, BrowserWindow> = new Map()

/**
 * Deny-and-route popup policy for a window's webContents.
 *
 * Applied to both the main window and the agent-generated dashboard popouts so
 * untrusted dashboard content cannot spawn arbitrary child windows via
 * window.open(). File-download URLs are streamed via downloadURL; everything
 * else is handed to the system browser. The popup itself is always denied
 * (SUP-219).
 */
export function installPopupHandler(webContents: WebContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    // Handle file download URLs - download directly without opening a popup
    if (url.includes('/api/agents/') && url.includes('/files/')) {
      webContents.downloadURL(url)
      return { action: 'deny' }
    }
    // For other URLs (OAuth, external links), open in the system browser
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

export function openDashboardWindow(agentSlug: string, dashboardSlug: string, apiPort: number) {
  const key = `${agentSlug}/${dashboardSlug}`

  // Focus existing window if already open
  const existing = dashboardWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const url = buildDashboardViewUrl(apiPort, agentSlug, dashboardSlug)
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'SuperAgent Dashboard',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // Dashboard content is agent-generated/untrusted — apply the same deny-and-route
  // popup policy as the main window so window.open() can't spawn child windows.
  installPopupHandler(win.webContents)
  win.loadURL(url)
  dashboardWindows.set(key, win)
  win.on('closed', () => dashboardWindows.delete(key))
}

export function closeAllDashboardWindows() {
  for (const win of dashboardWindows.values()) {
    if (!win.isDestroyed()) win.close()
  }
  dashboardWindows.clear()
}
