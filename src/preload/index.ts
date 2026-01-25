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
      onFullScreenChange: (callback: (isFullScreen: boolean) => void) => void
      removeFullScreenChange: () => void
      getFullScreenState: () => Promise<boolean>
      openExternal: (url: string) => Promise<void>
    }
  }
}
