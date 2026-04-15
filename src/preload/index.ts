import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // API configuration - get URL via IPC since port may vary
  getApiUrl: (): Promise<string> => {
    return ipcRenderer.invoke('get-api-url')
  },
  platform: process.platform,

  // OAuth callback handling - receives parsed callback params from main process
  onOAuthCallback: (callback: (params: {
    connectionId?: string | null
    status?: string | null
    toolkit?: string | null
    error?: string | null
  }) => void) => {
    ipcRenderer.on('oauth-callback', (_event, params) => callback(params))
  },

  // Remove OAuth callback listener
  removeOAuthCallback: () => {
    ipcRenderer.removeAllListeners('oauth-callback')
  },

  // MCP OAuth callback handling - receives result from main process after token exchange
  onMcpOAuthCallback: (callback: (params: {
    success: boolean
    mcpId?: string | null
    error?: string | null
  }) => void) => {
    ipcRenderer.on('mcp-oauth-callback', (_event, params) => callback(params))
  },

  // Remove MCP OAuth callback listener
  removeMcpOAuthCallback: () => {
    ipcRenderer.removeAllListeners('mcp-oauth-callback')
  },

  onPlatformAuthCallback: (callback: (params: {
    success: boolean
    email?: string | null
    error?: string | null
  }) => void) => {
    ipcRenderer.on('platform-auth-callback', (_event, params) => callback(params))
  },

  removePlatformAuthCallback: () => {
    ipcRenderer.removeAllListeners('platform-auth-callback')
  },

  // Full screen state handling
  onFullScreenChange: (callback: (isFullScreen: boolean) => void) => {
    ipcRenderer.on('fullscreen-change', (_event, isFullScreen) => callback(isFullScreen))
  },

  removeFullScreenChange: () => {
    ipcRenderer.removeAllListeners('fullscreen-change')
  },

  // Get initial full screen state
  getFullScreenState: (): Promise<boolean> => {
    return ipcRenderer.invoke('get-fullscreen-state')
  },

  // Open URL in system default browser
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke('open-external', url)
  },

  // Launch an elevated PowerShell window with a whitelisted command (Windows only)
  launchPowershellAdmin: (command: string): Promise<void> => {
    return ipcRenderer.invoke('launch-powershell-admin', command)
  },

  // Navigation from tray menu
  onNavigateToAgent: (callback: (agentSlug: string) => void) => {
    ipcRenderer.on('navigate-to-agent', (_event, agentSlug) => callback(agentSlug))
  },

  removeNavigateToAgent: () => {
    ipcRenderer.removeAllListeners('navigate-to-agent')
  },

  // Menu commands - open settings
  onOpenSettings: (callback: () => void) => {
    ipcRenderer.on('open-settings', () => callback())
  },

  removeOpenSettings: () => {
    ipcRenderer.removeAllListeners('open-settings')
  },

  // Menu commands - open create agent dialog
  onOpenCreateAgent: (callback: () => void) => {
    ipcRenderer.on('open-create-agent', () => callback())
  },

  removeOpenCreateAgent: () => {
    ipcRenderer.removeAllListeners('open-create-agent')
  },

  // Reclaim window focus (e.g. after Chrome steals it by opening a new tab)
  focusWindow: () => {
    ipcRenderer.send('focus-window')
  },

  // Tray visibility control
  setTrayVisible: (visible: boolean): Promise<void> => {
    return ipcRenderer.invoke('set-tray-visible', visible)
  },

  // Show OS notification
  showNotification: (title: string, body: string): Promise<void> => {
    return ipcRenderer.invoke('show-notification', { title, body })
  },

  // Set dock badge count (macOS)
  setBadgeCount: (count: number): Promise<void> => {
    return ipcRenderer.invoke('set-badge-count', count)
  },

  // Detect host browser availability
  detectHostBrowser: (): Promise<{ available: boolean; browser: string | null; path: string | null }> => {
    return ipcRenderer.invoke('detect-host-browser')
  },

  // Set native theme (controls vibrancy appearance on macOS)
  setNativeTheme: (theme: string): Promise<void> => {
    return ipcRenderer.invoke('set-native-theme', theme)
  },

  // Pop up the app menu at a position (Windows custom title bar)
  popupAppMenu: (x: number, y: number): Promise<void> => {
    return ipcRenderer.invoke('popup-app-menu', x, y)
  },

  // Open dashboard in a separate window
  openDashboardWindow: (agentSlug: string, dashboardSlug: string, dashboardName?: string): Promise<void> => {
    return ipcRenderer.invoke('open-dashboard-window', { agentSlug, dashboardSlug, dashboardName })
  },

  // Show the native emoji picker
  showEmojiPanel: (): Promise<void> => {
    return ipcRenderer.invoke('show-emoji-panel')
  },

  // Create a macOS dock shortcut for a dashboard
  createDockShortcut: (agentSlug: string, dashboardSlug: string, dashboardName: string, iconPng: Uint8Array): Promise<void> => {
    return ipcRenderer.invoke('create-dock-shortcut', { agentSlug, dashboardSlug, dashboardName, iconPng: Array.from(iconPng) })
  },

  // Get the real filesystem path for a dropped/selected file
  getPathForFile: (file: File): string => {
    return webUtils.getPathForFile(file)
  },

  // Open a native directory picker dialog
  openDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke('open-directory')
  },

  // Get recently opened files from the OS
  getRecentFiles: (limit?: number): Promise<{ name: string; path: string; thumbnail?: string }[]> => {
    return ipcRenderer.invoke('get-recent-files', limit)
  },

  // Read a local file as a buffer (for recent files attachment)
  readLocalFile: (filePath: string): Promise<{ buffer: ArrayBuffer; name: string; type: string } | null> => {
    return ipcRenderer.invoke('read-local-file', filePath)
  },

  // Auto-update
  checkForUpdates: (): Promise<void> => {
    return ipcRenderer.invoke('check-for-updates')
  },

  downloadUpdate: (): Promise<void> => {
    return ipcRenderer.invoke('download-update')
  },

  installUpdate: (): Promise<void> => {
    return ipcRenderer.invoke('install-update')
  },

  getUpdateStatus: (): Promise<any> => {
    return ipcRenderer.invoke('get-update-status')
  },

  onUpdateStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('update-status', (_event, status) => callback(status))
  },

  removeUpdateStatus: () => {
    ipcRenderer.removeAllListeners('update-status')
  },
})

// OAuth callback params from main process
interface OAuthCallbackParams {
  connectionId?: string | null
  status?: string | null
  toolkit?: string | null
  error?: string | null
}

// Type declarations for the exposed API
declare global {
  interface Window {
    electronAPI?: {
      getApiUrl: () => Promise<string>
      platform: string
      onOAuthCallback: (callback: (params: OAuthCallbackParams) => void) => void
      removeOAuthCallback: () => void
      onMcpOAuthCallback: (callback: (params: { success: boolean; mcpId?: string | null; error?: string | null }) => void) => void
      removeMcpOAuthCallback: () => void
      onPlatformAuthCallback: (callback: (params: { success: boolean; email?: string | null; error?: string | null }) => void) => void
      removePlatformAuthCallback: () => void
      onFullScreenChange: (callback: (isFullScreen: boolean) => void) => void
      removeFullScreenChange: () => void
      getFullScreenState: () => Promise<boolean>
      openExternal: (url: string) => Promise<void>
      launchPowershellAdmin: (command: string) => Promise<void>
      onNavigateToAgent: (callback: (agentSlug: string) => void) => void
      removeNavigateToAgent: () => void
      onOpenSettings: (callback: () => void) => void
      removeOpenSettings: () => void
      onOpenCreateAgent: (callback: () => void) => void
      removeOpenCreateAgent: () => void
      setTrayVisible: (visible: boolean) => Promise<void>
      showNotification: (title: string, body: string) => Promise<void>
      setBadgeCount: (count: number) => Promise<void>
      detectHostBrowser: () => Promise<{ available: boolean; browser: string | null; path: string | null }>
      setNativeTheme: (theme: string) => Promise<void>
      popupAppMenu: (x: number, y: number) => Promise<void>
      openDashboardWindow: (agentSlug: string, dashboardSlug: string, dashboardName?: string) => Promise<void>
      showEmojiPanel: () => Promise<void>
      createDockShortcut: (agentSlug: string, dashboardSlug: string, dashboardName: string, iconPng: Uint8Array) => Promise<void>
      getPathForFile: (file: File) => string
      openDirectory: () => Promise<string | null>
      getRecentFiles: (limit?: number) => Promise<{ name: string; path: string; thumbnail?: string }[]>
      readLocalFile: (filePath: string) => Promise<{ buffer: ArrayBuffer; name: string; type: string } | null>
      checkForUpdates: () => Promise<void>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      getUpdateStatus: () => Promise<any>
      onUpdateStatus: (callback: (status: any) => void) => void
      removeUpdateStatus: () => void
    }
  }
}
