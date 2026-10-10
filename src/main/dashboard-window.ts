import { BrowserWindow, type Session, type WebContents } from 'electron'
import { isIP } from 'node:net'
import { refreshCloudProxyTarget } from '@shared/lib/services/cloud-proxy-target'
import { CREDENTIAL_RESPONSE_HEADERS } from '../api/routes/cloud-proxy'
import { buildDashboardViewUrl } from '@shared/lib/dashboard-url'
import { SESSION_CHALLENGE } from '@shared/lib/auth/session-challenge'
import { DASHBOARD_CHROME_HEIGHT, dashboardChromeScript } from './dashboard-window-chrome'
import { safeOpenExternal } from './safe-open-external'

// Open dashboard popouts, keyed by API base URL + `${agentSlug}/${dashboardSlug}`.
// The base URL is part of the identity, not decoration: two deployments can hold
// an agent of the same slug, and reusing a window across them would show the
// wrong one's dashboard under the right one's name. The raw join is fine as a
// dedup key — only the loaded URL needs per-segment encoding.
const dashboardWindows: Map<string, { win: BrowserWindow; webContentsId: number; cloud: boolean }> = new Map()

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

export type OwnedWindow = 'main' | 'cloud-popout' | null

export interface WorkspaceRequest {
  url: string
  resourceType: string
  method: string
  /** The requesting frame's origin first, up to the window's top frame. */
  frameOrigins: readonly string[]
}

/**
 * Whether a page is on the workspace's site, as a SameSite cookie judges it.
 * Every workspace host is `<slug>.<ingress domain>`, and no ingress domain is
 * a public suffix, so the site is the host minus its first label. A host that
 * would leave one label (localhost, an apex) or an IP is its own site.
 */
function isWorkspaceSite(origin: string, workspaceOrigin: string): boolean {
  if (!URL.canParse(origin)) return false
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- checked by canParse above
  const page = new URL(origin)
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- the workspace origin was parsed on read
  const { protocol, hostname } = new URL(workspaceOrigin)
  const parent = hostname.slice(hostname.indexOf('.') + 1)
  const site = isIP(hostname) || !parent.includes('.') ? hostname : parent
  return page.protocol === protocol && (page.hostname === site || page.hostname.endsWith(`.${site}`))
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
  const navigation = request.resourceType === 'mainFrame' || request.resourceType === 'subFrame'
  return frameOrigins.length > 0 && frameOrigins.every((origin, i) =>
    origin === RENDERER_ORIGIN
    || origin === workspaceOrigin
    // Where a browser's Lax cookie goes too: a frame navigating back from a
    // same-site page, and a popout's own top-level GET from anywhere.
    || (i === 0 && navigation && isWorkspaceSite(origin, workspaceOrigin))
    || (window === 'cloud-popout' && request.resourceType === 'mainFrame' && request.method === 'GET'))
}

interface RequestDetails {
  id: number
  url: string
  resourceType: string
  method: string
  webContentsId?: number
  frame?: { origin: string; parent: RequestDetails['frame'] } | null
}

function workspaceRequestOf({ url, resourceType, method, frame }: RequestDetails): WorkspaceRequest | null {
  const frameOrigins: string[] = []
  try {
    for (let f = frame; f; f = f.parent) frameOrigins.push(f.origin)
    return { url, resourceType, method, frameOrigins }
  } catch {
    // A frame already disposed in the renderer throws on access. Its request is not signed.
    return null
  }
}

const isSessionRejection = (headers: Record<string, string[]>) =>
  Object.entries(headers).some(([name, values]) => name.toLowerCase() === 'www-authenticate' && values.includes(SESSION_CHALLENGE))

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
  // Per request in flight: the token this hop carried (null when it was not
  // signed) and whether it was retried.
  const signedRequests = new Map<number, { token: string | null; retried: boolean }>()
  const isCloudPopout = (id: number) =>
    [...dashboardWindows.values()].some((entry) => entry.cloud && entry.webContentsId === id)
  const windowOf = (id: number | undefined): OwnedWindow =>
    id === undefined ? null
      : id === mainWebContentsId() ? 'main'
        : isCloudPopout(id) ? 'cloud-popout' : null

  target.webRequest.onBeforeSendHeaders((details, callback) => {
    const window = windowOf(details.webContentsId)
    const workspace = window ? currentWorkspace() : null
    const earlier = signedRequests.get(details.id)
    // A page's own Authorization never reaches the workspace, and ours never
    // follows a redirect away from it.
    const requestHeaders = withoutHeaders(details.requestHeaders, new Set(['authorization']))
    const request = workspace && workspaceRequestOf(details)
    if (!workspace || !request || !shouldSignWorkspaceRequest(request, workspace.deploymentUrl, window)) {
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
    if (details.statusCode !== 401 || request.retried || !isSessionRejection(responseHeaders)) {
      callback({ responseHeaders })
      return
    }
    // Same recovery as the cloud proxy: re-mint, then retry once.
    request.retried = true
    const sentWith = request.token
    void refreshCloudProxyTarget().then((fresh) => {
      callback(fresh && fresh.token !== sentWith
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
  const existing = dashboardWindows.get(key)?.win
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
    win.on('page-title-updated', (event, title) => {
      event.preventDefault()
      win.setTitle(`Cloud workspace — ${title}`)
    })
  }
  win.loadURL(url)
  dashboardWindows.set(key, { win, webContentsId: win.webContents.id, cloud })
  win.on('closed', () => dashboardWindows.delete(key))
}

export function closeAllDashboardWindows() {
  for (const { win } of dashboardWindows.values()) {
    if (!win.isDestroyed()) win.close()
  }
  dashboardWindows.clear()
}
