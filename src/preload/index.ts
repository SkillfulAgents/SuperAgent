import { contextBridge, ipcRenderer } from 'electron'

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
      onFullScreenChange: (callback: (isFullScreen: boolean) => void) => void
      removeFullScreenChange: () => void
      getFullScreenState: () => Promise<boolean>
      openExternal: (url: string) => Promise<void>
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
      checkForUpdates: () => Promise<void>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      getUpdateStatus: () => Promise<any>
      onUpdateStatus: (callback: (status: any) => void) => void
      removeUpdateStatus: () => void
    }
  }
}
