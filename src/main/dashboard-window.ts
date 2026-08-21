import { BrowserWindow, type WebContents } from 'electron'
import { buildDashboardViewUrl } from '@shared/lib/dashboard-url'
import { safeOpenExternal } from './safe-open-external'
import { ensureCloudDashboardSession } from './cloud-dashboard-session'

// Open dashboard popouts, keyed by API base URL + `${agentSlug}/${dashboardSlug}`.
// The base URL is part of the identity, not decoration: two deployments can hold
// an agent of the same slug, and reusing a window across them would show the
// wrong one's dashboard under the right one's name. The raw join is fine as a
// dedup key — only the loaded URL needs per-segment encoding.
const dashboardWindows: Map<string, BrowserWindow> = new Map()

/**
 * Deny-and-route popup policy for a window's webContents.
 *
 * Applied to both the main window and the agent-generated dashboard popouts so
 * untrusted dashboard content cannot spawn arbitrary child windows via
 * window.open(). File-download URLs are streamed via downloadURL; other URLs go
 * to the system browser via safeOpenExternal, which scheme-validates first so a
 * popup can't ask the OS shell to launch file:/javascript:/custom-protocol
 * handlers (SUP-214). The popup itself is always denied (SUP-219).
 */
export function installPopupHandler(webContents: WebContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    // Handle file download URLs - download directly without opening a popup
    if (url.includes('/api/agents/') && url.includes('/files/')) {
      webContents.downloadURL(url)
      return { action: 'deny' }
    }
    // For other URLs (OAuth, external links), open in the system browser after
    // scheme validation (SUP-214). Fire-and-forget; the popup is denied either way.
    void safeOpenExternal(url)
    return { action: 'deny' }
  })
}

/**
 * The origin and the path a cloud base URL adds ahead of `/api/…`, or null for
 * a local base URL (a bare origin, so nothing to add) and for anything
 * unparseable.
 */
function proxyRouteOf(apiBaseUrl: string): { origin: string; prefix: string } | null {
  try {
    const url = new URL(apiBaseUrl)
    const prefix = url.pathname.replace(/\/+$/, '')
    return prefix ? { origin: url.origin, prefix } : null
  } catch {
    return null
  }
}

/**
 * `apiBaseUrl` is the door the rest of the app uses (local API, or the cloud
 * prefix). When the desktop jar has a session cookie, the popout loads the
 * cloud site instead. Same jar as the main window. No extra partition.
 */
export async function openDashboardWindow(
  agentSlug: string,
  dashboardSlug: string,
  apiBaseUrl: string,
): Promise<void> {
  const target = proxyRouteOf(apiBaseUrl) ? 'cloud' : 'local'
  let session
  try {
    session = await ensureCloudDashboardSession(target)
  } catch {
    session = { useCloudOrigin: false, origin: null }
  }

  const loadBase = target === 'cloud' && session.useCloudOrigin && session.origin
    ? session.origin
    : apiBaseUrl
  const key = `${loadBase}|${agentSlug}/${dashboardSlug}`
  const drivingCloud = target === 'cloud'

  const existing = dashboardWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const url = buildDashboardViewUrl(loadBase, agentSlug, dashboardSlug)
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Gamut Dashboard',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  installPopupHandler(win.webContents)
  if (drivingCloud) {
    win.on('page-title-updated', (event, title) => {
      event.preventDefault()
      win.setTitle(`Cloud workspace — ${title}`)
    })
  }
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
