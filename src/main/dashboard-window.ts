import { BrowserWindow, type Session, type WebContents } from 'electron'
import { refreshCloudProxyTarget } from '@shared/lib/services/cloud-proxy-target'
import { buildDashboardViewUrl } from '@shared/lib/dashboard-url'
import { DASHBOARD_CHROME_HEIGHT, dashboardChromeScript } from './dashboard-window-chrome'
import { safeOpenExternal } from './safe-open-external'

// Open dashboard popouts, keyed by API base URL + `${agentSlug}/${dashboardSlug}`.
// The base URL is part of the identity, not decoration: two deployments can hold
// an agent of the same slug, and reusing a window across them would show the
// wrong one's dashboard under the right one's name. The raw join is fine as a
// dedup key — only the loaded URL needs per-segment encoding.
const dashboardWindows: Map<string, BrowserWindow> = new Map()

function installDashboardChrome(win: BrowserWindow, titlePrefix = ''): void {
  const script = dashboardChromeScript(process.platform, titlePrefix)
  win.webContents.on('dom-ready', () => {
    void win.webContents.executeJavaScript(script).catch((error) => {
      // A close or navigation can destroy the document between dom-ready and
      // execution. That is harmless; the next document gets its own attempt.
      if (!win.isDestroyed()) console.error('Failed to install dashboard window chrome:', error)
    })
  })
}

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

const RENDERER_ORIGIN = process.env.ELECTRON_RENDERER_URL
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- set by electron-vite dev to the renderer's URL
  ? new URL(process.env.ELECTRON_RENDERER_URL).origin
  : 'file://'

const cloudPopoutIds = new Set<number>()

export type OwnedWindow = 'main' | 'cloud-popout' | null

export interface WorkspaceRequest {
  url: string
  resourceType: string
  /** The requesting frame's origin first, up to the window's top frame. */
  frameOrigins: readonly string[]
  /** The window's top frame has never committed a document. */
  topFrameEmpty: boolean
}

/**
 * Cloud dashboards load at the workspace's own address, as in a browser, and
 * main signs them in place of the browser's login cookie, so the page never
 * holds the token. Local dashboards share this session and must not be signed.
 */
export function shouldSignWorkspaceRequest(request: WorkspaceRequest, workspaceOrigin: string, window: OwnedWindow): boolean {
  if (!window) return false
  const socketOrigin = workspaceOrigin.replace(/^http/, 'ws')
  if (!request.url.startsWith(`${workspaceOrigin}/`) && !request.url.startsWith(`${socketOrigin}/`)) return false
  const { frameOrigins } = request
  return frameOrigins.length > 0 && frameOrigins.every((origin, i) =>
    origin === RENDERER_ORIGIN
    || origin === workspaceOrigin
    // A popout's first navigation starts from its never-loaded top frame.
    || (window === 'cloud-popout' && origin === 'null' && i === frameOrigins.length - 1
      && request.resourceType === 'mainFrame' && request.topFrameEmpty))
}

interface RequestDetails {
  id: number
  url: string
  resourceType: string
  webContentsId?: number
  frame?: { origin: string; url: string; parent: RequestDetails['frame'] } | null
}

function workspaceRequestOf({ url, resourceType, frame }: RequestDetails): WorkspaceRequest {
  const frameOrigins: string[] = []
  let top = frame
  for (let f = frame; f; f = f.parent) {
    frameOrigins.push(f.origin)
    top = f
  }
  return { url, resourceType, frameOrigins, topFrameEmpty: top?.url === '' }
}

// The same credentials the cloud proxy keeps out of the renderer.
const CREDENTIAL_RESPONSE_HEADERS = new Set(['set-cookie', 'set-auth-token'])

// Per request in flight: the token this hop carried (null when it was not
// signed) and whether it was retried. Module-level so a reinstall on window
// re-create keeps requests already in flight.
const signedRequests = new Map<number, { token: string | null; retried: boolean }>()

const withoutHeaders = <T>(headers: Record<string, T>, names: ReadonlySet<string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())))

/**
 * `currentWorkspace` answers only while the app is driving a cloud workspace,
 * and is read per request, so a switch to local or a disconnect stops signing
 * with nothing to reset. Each signed request remembers the token it carried, so
 * its response is cleaned and its 401 retried once even if the record changed
 * in between.
 */
export function installCloudDashboardAuth(
  target: Session,
  mainWebContentsId: () => number | null,
  currentWorkspace: () => { deploymentUrl: string; token: string } | null,
): void {
  const windowOf = (id: number | undefined): OwnedWindow =>
    id === undefined ? null
      : id === mainWebContentsId() ? 'main'
        : cloudPopoutIds.has(id) ? 'cloud-popout' : null

  target.webRequest.onBeforeSendHeaders((details, callback) => {
    const window = windowOf(details.webContentsId)
    const workspace = window ? currentWorkspace() : null
    const earlier = signedRequests.get(details.id)
    // A page's own Authorization never reaches the workspace, and ours never
    // follows a redirect away from it.
    const requestHeaders = withoutHeaders(details.requestHeaders, new Set(['authorization']))
    if (!workspace || !shouldSignWorkspaceRequest(workspaceRequestOf(details), workspace.deploymentUrl, window)) {
      if (earlier) earlier.token = null
      callback({ requestHeaders: earlier ? requestHeaders : details.requestHeaders })
      return
    }
    signedRequests.set(details.id, { token: workspace.token, retried: earlier?.retried ?? false })
    callback({ requestHeaders: { ...requestHeaders, Authorization: `Bearer ${workspace.token}` } })
  })

  target.webRequest.onHeadersReceived((details, callback) => {
    const request = signedRequests.get(details.id)
    if (!request?.token) {
      callback({})
      return
    }
    const responseHeaders = withoutHeaders(details.responseHeaders ?? {}, CREDENTIAL_RESPONSE_HEADERS)
    if (details.statusCode !== 401 || request.retried) {
      callback({ responseHeaders })
      return
    }
    // Same recovery as the cloud proxy: re-mint, then retry once. A socket
    // cannot be redirected; its next reconnect picks up the fresh token.
    request.retried = true
    const sentWith = request.token
    void refreshCloudProxyTarget().then((fresh) => {
      callback(fresh && fresh.token !== sentWith && details.resourceType !== 'webSocket'
        ? { statusLine: 'HTTP/1.1 307 Temporary Redirect', responseHeaders: { ...responseHeaders, Location: [details.url] } }
        : { responseHeaders })
    })
  })

  const forget = ({ id }: { id: number }) => signedRequests.delete(id)
  target.webRequest.onCompleted(forget)
  target.webRequest.onErrorOccurred(forget)
}

/**
 * `apiBaseUrl` is where the dashboard lives: the local API, or the cloud
 * workspace's own address. Popouts are built in main, so they have to be told;
 * a hard-coded local origin opens a dashboard belonging to a different
 * deployment's agent of the same name.
 */
export function openDashboardWindow(agentSlug: string, dashboardSlug: string, apiBaseUrl: string, cloud = false) {
  const key = `${apiBaseUrl}|${agentSlug}/${dashboardSlug}`

  // Focus existing window if already open
  const existing = dashboardWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const url = buildDashboardViewUrl(apiBaseUrl, agentSlug, dashboardSlug)
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Gamut Dashboard',
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 14, y: 8 },
    }),
    ...(process.platform === 'win32' && {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: {
        color: '#111111',
        symbolColor: '#d4d4d4',
        height: DASHBOARD_CHROME_HEIGHT,
      },
    }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // Unlike autoHideMenuBar, removeMenu prevents the inherited File/Edit menu
  // from reappearing when Alt is pressed on Windows.
  if (process.platform === 'win32') win.removeMenu()
  installDashboardChrome(win, cloud ? 'Cloud workspace — ' : '')
  // Dashboard content is agent-generated/untrusted — apply the same deny-and-route
  // popup policy as the main window so window.open() can't spawn child windows.
  installPopupHandler(win.webContents)
  // A cloud popout is otherwise indistinguishable from a local one. Keep the
  // workspace marker in both the native/taskbar title and the app-owned title
  // bar above the dashboard iframe.
  if (cloud) {
    cloudPopoutIds.add(win.webContents.id)
    win.on('page-title-updated', (event, title) => {
      event.preventDefault()
      win.setTitle(`Cloud workspace — ${title}`)
    })
  }
  win.loadURL(url)
  dashboardWindows.set(key, win)
  const id = win.webContents.id
  win.on('closed', () => {
    dashboardWindows.delete(key)
    cloudPopoutIds.delete(id)
  })
}

export function closeAllDashboardWindows() {
  for (const win of dashboardWindows.values()) {
    if (!win.isDestroyed()) win.close()
  }
  dashboardWindows.clear()
}
