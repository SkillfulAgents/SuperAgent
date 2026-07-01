import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // API configuration - get URL via IPC since port may vary
  getApiUrl: (): Promise<string> => {
    return ipcRenderer.invoke('get-api-url')
  },
  platform: process.platform,
  osVersion: process.getSystemVersion(),

  // OAuth callback handling - receives parsed callback params from main process.
  // Returns a per-listener unsubscribe so concurrent subscribers (multiple
  // toolkits / overlapping reconnect flows) can be torn down independently.
  onOAuthCallback: (callback: (params: {
    connectionId?: string | null
    status?: string | null
    toolkit?: string | null
    error?: string | null
  }) => void): (() => void) => {
    const handler = (_event: unknown, params: unknown) => callback(params as never)
    ipcRenderer.on('oauth-callback', handler)
    return () => {
      ipcRenderer.removeListener('oauth-callback', handler)
    }
  },

  // Channel-wide reset — removes EVERY oauth-callback listener. Prefer the
  // unsubscribe returned by onOAuthCallback for per-component cleanup.
  removeOAuthCallback: () => {
    ipcRenderer.removeAllListeners('oauth-callback')
  },

  // MCP OAuth callback handling - receives result from main process after token exchange
  onMcpOAuthCallback: (callback: (params: {
    success: boolean
    mcpId?: string | null
    error?: string | null
  }) => void): (() => void) => {
    const handler = (_event: unknown, params: unknown) => callback(params as never)
    ipcRenderer.on('mcp-oauth-callback', handler)
    return () => {
      ipcRenderer.removeListener('mcp-oauth-callback', handler)
    }
  },

  // Channel-wide reset — prefer the unsubscribe returned by onMcpOAuthCallback.
  removeMcpOAuthCallback: () => {
    ipcRenderer.removeAllListeners('mcp-oauth-callback')
  },

  onPlatformAuthCallback: (callback: (params: {
    success: boolean
    email?: string | null
    error?: string | null
  }) => void): (() => void) => {
    const handler = (_event: unknown, params: unknown) => callback(params as never)
    ipcRenderer.on('platform-auth-callback', handler)
    return () => {
      ipcRenderer.removeListener('platform-auth-callback', handler)
    }
  },

  // Channel-wide reset — prefer the unsubscribe returned by onPlatformAuthCallback.
  removePlatformAuthCallback: () => {
    ipcRenderer.removeAllListeners('platform-auth-callback')
  },

  // Full screen state handling
  onFullScreenChange: (callback: (isFullScreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isFullScreen: unknown) => callback(isFullScreen as boolean)
    ipcRenderer.on('fullscreen-change', handler)
    return () => {
      ipcRenderer.removeListener('fullscreen-change', handler)
    }
  },

  // Channel-wide reset — prefer the unsubscribe returned by onFullScreenChange.
  removeFullScreenChange: () => {
    ipcRenderer.removeAllListeners('fullscreen-change')
  },

  // Get initial full screen state
  getFullScreenState: (): Promise<boolean> => {
    return ipcRenderer.invoke('get-fullscreen-state')
  },

  // Custom window controls (Windows custom title bar)
  minimizeWindow: () => {
    ipcRenderer.send('window-minimize')
  },
  toggleMaximizeWindow: () => {
    ipcRenderer.send('window-toggle-maximize')
  },
  closeWindow: () => {
    ipcRenderer.send('window-close')
  },
  getWindowMaximizedState: (): Promise<boolean> => {
    return ipcRenderer.invoke('get-window-maximized-state')
  },
  onWindowMaximizedChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isMaximized: unknown) => callback(isMaximized as boolean)
    ipcRenderer.on('window-maximized-change', handler)
    return () => {
      ipcRenderer.removeListener('window-maximized-change', handler)
    }
  },
  // Channel-wide reset — prefer the unsubscribe returned by onWindowMaximizedChange.
  removeWindowMaximizedChange: () => {
    ipcRenderer.removeAllListeners('window-maximized-change')
  },

  // Open URL in system default browser
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke('open-external', url)
  },

  // Launch an elevated PowerShell window with a whitelisted command (Windows only)
  launchPowershellAdmin: (command: string): Promise<void> => {
    return ipcRenderer.invoke('launch-powershell-admin', command)
  },

  // Navigation from tray menu or deep links.
  onNavigateToAgent: (callback: (agentSlug: string, sessionId?: string | null) => void): (() => void) => {
    const handler = (_event: unknown, agentSlug: unknown, sessionId: unknown) =>
      callback(agentSlug as string, sessionId as string | null | undefined)
    ipcRenderer.on('navigate-to-agent', handler)
    return () => {
      ipcRenderer.removeListener('navigate-to-agent', handler)
    }
  },

  // Channel-wide reset — prefer the unsubscribe returned by onNavigateToAgent.
  removeNavigateToAgent: () => {
    ipcRenderer.removeAllListeners('navigate-to-agent')
  },

  // Menu commands - open settings
  onOpenSettings: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('open-settings', handler)
    return () => {
      ipcRenderer.removeListener('open-settings', handler)
    }
  },

  // Channel-wide reset — prefer the unsubscribe returned by onOpenSettings.
  removeOpenSettings: () => {
    ipcRenderer.removeAllListeners('open-settings')
  },

  // Menu commands - open create agent dialog
  onOpenCreateAgent: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('open-create-agent', handler)
    return () => {
      ipcRenderer.removeListener('open-create-agent', handler)
    }
  },

  // Channel-wide reset — prefer the unsubscribe returned by onOpenCreateAgent.
  removeOpenCreateAgent: () => {
    ipcRenderer.removeAllListeners('open-create-agent')
  },

  onHistoryNavigationCommand: (callback: (command: 'back' | 'forward') => void): (() => void) => {
    const handler = (_event: unknown, command: unknown) => {
      if (command === 'back' || command === 'forward') callback(command)
    }
    ipcRenderer.on('history-navigation-command', handler)
    return () => {
      ipcRenderer.removeListener('history-navigation-command', handler)
    }
  },

  // Channel-wide reset — prefer the unsubscribe returned by onHistoryNavigationCommand.
  removeHistoryNavigationCommand: () => {
    ipcRenderer.removeAllListeners('history-navigation-command')
  },

  // Reclaim window focus (e.g. after Chrome steals it by opening a new tab)
  focusWindow: () => {
    ipcRenderer.send('focus-window')
  },

  // Notify main of sidebar collapsed state so it can reposition macOS traffic lights
  setSidebarCollapsed: (collapsed: boolean) => {
    ipcRenderer.send('set-sidebar-collapsed', collapsed)
  },

  // Tray visibility control
  setTrayVisible: (visible: boolean): Promise<void> => {
    return ipcRenderer.invoke('set-tray-visible', visible)
  },

  // Show OS notification. `actions` + `context` enable action buttons (macOS
  // only — Windows/Linux ignore the actions array). Listen with
  // onNotificationEvent to receive click/action callbacks.
  showNotification: (
    title: string,
    body: string,
    actions?: Array<{ text: string }>,
    context?: unknown,
  ): Promise<void> => {
    return ipcRenderer.invoke('show-notification', { title, body, actions, context })
  },

  // Subscribe to notification interaction events (click / action button).
  // Returns an unsubscribe function.
  onNotificationEvent: (
    callback: (event: { type: 'click' | 'action'; actionIndex?: number; context?: unknown }) => void,
  ): (() => void) => {
    const handler = (_e: unknown, data: { type: 'click' | 'action'; actionIndex?: number; context?: unknown }) => callback(data)
    ipcRenderer.on('notification-event', handler)
    return () => {
      ipcRenderer.off('notification-event', handler)
    }
  },

  // Pull events queued while the window was closed (main-process fallback
  // notifications). Renderer calls this once on mount so click/action
  // events captured before any IPC listener existed still get dispatched.
  flushPendingNotificationEvents: (): Promise<{
    events: Array<{ type: 'click' | 'action'; actionIndex?: number; context?: unknown }>
    navigations: Array<{ agentSlug: string; sessionId: string | null }>
  }> => {
    return ipcRenderer.invoke('flush-pending-notification-events')
  },

  // Pull menu commands (Settings / New Agent / navigate-to-agent) queued while
  // the window was closed. The renderer calls this once on mount so commands
  // captured before its IPC listeners existed still get dispatched (SUP-264).
  flushPendingMenuCommands: (): Promise<
    Array<
      | { channel: 'navigate-to-agent'; agentSlug: string }
      | { channel: 'open-settings' }
      | { channel: 'open-create-agent' }
    >
  > => {
    return ipcRenderer.invoke('flush-pending-menu-commands')
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

  // Reveal a path in the OS file manager (Finder / Explorer / Files)
  showInFolder: (hostPath: string): Promise<string | null> => {
    return ipcRenderer.invoke('show-in-folder', hostPath)
  },

  // Get recently opened files from the OS
  getRecentFiles: (limit?: number): Promise<{ name: string; path: string; thumbnail?: string }[]> => {
    return ipcRenderer.invoke('get-recent-files', limit)
  },

  // Read a local file as a buffer (for recent files attachment)
  readLocalFile: (filePath: string): Promise<{ buffer: ArrayBuffer; name: string; type: string } | null> => {
    return ipcRenderer.invoke('read-local-file', filePath)
  },

  // Keep awake (macOS lid-close sleep prevention)
  setKeepAwake: (enabled: boolean): Promise<void> => {
    return ipcRenderer.invoke('set-keep-awake', enabled)
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
    const handler = (_event: Electron.IpcRendererEvent, status: any) => callback(status)
    ipcRenderer.on('update-status', handler)
    return () => {
      ipcRenderer.removeListener('update-status', handler)
    }
  },

  removeUpdateStatus: () => {
    ipcRenderer.removeAllListeners('update-status')
  },

  // --- Quick-dispatch launcher ---

  // Fired by the launcher renderer after an agent is dispatched: hide the panel
  // and raise the main window on the new session.
  quickDispatchDispatched: (payload: { agentSlug: string; sessionId: string }) => {
    ipcRenderer.send('quick-dispatch:dispatched', payload)
  },
  // Dismiss the launcher (Esc / blur from the renderer).
  quickDispatchClose: () => {
    ipcRenderer.send('quick-dispatch:close')
  },
  // Report measured content height so the frameless panel hugs its contents.
  quickDispatchResize: (height: number) => {
    ipcRenderer.send('quick-dispatch:resize', height)
  },
  // Suppress blur-to-hide while a native picker is open (true), then restore (false).
  quickDispatchSetModal: (open: boolean) => {
    ipcRenderer.send('quick-dispatch:set-modal', open)
  },
  // "Set up voice input" → open the main window's settings.
  quickDispatchOpenSettings: () => {
    ipcRenderer.send('quick-dispatch:open-settings')
  },
  // JS window-drag: the panel can't use a CSS drag region (inert to file drops),
  // so the renderer drives the move — start, then stream cursor deltas, then end.
  quickDispatchDragStart: () => {
    ipcRenderer.send('quick-dispatch:drag-start')
  },
  quickDispatchDragMove: (delta: { dx: number; dy: number }) => {
    ipcRenderer.send('quick-dispatch:drag-move', delta)
  },
  quickDispatchDragEnd: () => {
    ipcRenderer.send('quick-dispatch:drag-end')
  },
  // Main → launcher: the panel was just shown (focus input, re-measure).
  onQuickDispatchShown: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('quick-dispatch:shown', handler)
    return () => {
      ipcRenderer.removeListener('quick-dispatch:shown', handler)
    }
  },
  // Main → launcher: a second shortcut press while open → toggle dictation.
  onQuickDispatchToggleDictation: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('quick-dispatch:toggle-dictation', handler)
    return () => {
      ipcRenderer.removeListener('quick-dispatch:toggle-dictation', handler)
    }
  },
  // Pull the queued dock-drop / "Open With" file paths (race-free: the renderer
  // drains on mount and on the `attach-pending` ping below).
  quickDispatchDrainAttach: (): Promise<string[]> => ipcRenderer.invoke('quick-dispatch:drain-attach'),
  // Main → launcher: files are queued for attach — drain them now.
  onQuickDispatchAttachPending: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('quick-dispatch:attach-pending', handler)
    return () => {
      ipcRenderer.removeListener('quick-dispatch:attach-pending', handler)
    }
  },
  // Main → launcher: the panel was hidden — reset transient state (attachments).
  onQuickDispatchReset: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('quick-dispatch:reset', handler)
    return () => {
      ipcRenderer.removeListener('quick-dispatch:reset', handler)
    }
  },
  // Re-bind the global launcher shortcut (from Settings). Resolves to the
  // registration result so the UI can surface conflicts.
  setGlobalDispatchShortcut: (accelerator: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('set-global-dispatch-shortcut', accelerator)
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
      osVersion: string
      onOAuthCallback: (callback: (params: OAuthCallbackParams) => void) => () => void
      removeOAuthCallback: () => void
      onMcpOAuthCallback: (callback: (params: { success: boolean; mcpId?: string | null; error?: string | null }) => void) => () => void
      removeMcpOAuthCallback: () => void
      onPlatformAuthCallback: (callback: (params: { success: boolean; email?: string | null; error?: string | null }) => void) => () => void
      removePlatformAuthCallback: () => void
      onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void
      removeFullScreenChange: () => void
      getFullScreenState: () => Promise<boolean>
      minimizeWindow: () => void
      toggleMaximizeWindow: () => void
      closeWindow: () => void
      getWindowMaximizedState: () => Promise<boolean>
      onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
      removeWindowMaximizedChange: () => void
      openExternal: (url: string) => Promise<void>
      launchPowershellAdmin: (command: string) => Promise<void>
      onNavigateToAgent: (callback: (agentSlug: string, sessionId?: string | null) => void) => () => void
      removeNavigateToAgent: () => void
      onOpenSettings: (callback: () => void) => () => void
      removeOpenSettings: () => void
      onOpenCreateAgent: (callback: () => void) => () => void
      removeOpenCreateAgent: () => void
      onHistoryNavigationCommand: (callback: (command: 'back' | 'forward') => void) => () => void
      removeHistoryNavigationCommand: () => void
      setSidebarCollapsed: (collapsed: boolean) => void
      setTrayVisible: (visible: boolean) => Promise<void>
      showNotification: (
        title: string,
        body: string,
        actions?: Array<{ text: string }>,
        context?: unknown,
      ) => Promise<void>
      onNotificationEvent: (
        callback: (event: { type: 'click' | 'action'; actionIndex?: number; context?: unknown }) => void,
      ) => () => void
      flushPendingNotificationEvents: () => Promise<{
        events: Array<{ type: 'click' | 'action'; actionIndex?: number; context?: unknown }>
        navigations: Array<{ agentSlug: string; sessionId: string | null }>
      }>
      flushPendingMenuCommands: () => Promise<
        Array<
          | { channel: 'navigate-to-agent'; agentSlug: string }
          | { channel: 'open-settings' }
          | { channel: 'open-create-agent' }
        >
      >
      setBadgeCount: (count: number) => Promise<void>
      detectHostBrowser: () => Promise<{ available: boolean; browser: string | null; path: string | null }>
      setNativeTheme: (theme: string) => Promise<void>
      popupAppMenu: (x: number, y: number) => Promise<void>
      openDashboardWindow: (agentSlug: string, dashboardSlug: string, dashboardName?: string) => Promise<void>
      showEmojiPanel: () => Promise<void>
      createDockShortcut: (agentSlug: string, dashboardSlug: string, dashboardName: string, iconPng: Uint8Array) => Promise<void>
      getPathForFile: (file: File) => string
      openDirectory: () => Promise<string | null>
      showInFolder: (hostPath: string) => Promise<string | null>
      getRecentFiles: (limit?: number) => Promise<{ name: string; path: string; thumbnail?: string }[]>
      readLocalFile: (filePath: string) => Promise<{ buffer: ArrayBuffer; name: string; type: string } | null>
      setKeepAwake: (enabled: boolean) => Promise<void>
      checkForUpdates: () => Promise<void>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      getUpdateStatus: () => Promise<any>
      onUpdateStatus: (callback: (status: any) => void) => () => void
      removeUpdateStatus: () => void
      quickDispatchDispatched: (payload: { agentSlug: string; sessionId: string }) => void
      quickDispatchClose: () => void
      quickDispatchResize: (height: number) => void
      quickDispatchSetModal: (open: boolean) => void
      quickDispatchOpenSettings: () => void
      quickDispatchDragStart: () => void
      quickDispatchDragMove: (delta: { dx: number; dy: number }) => void
      quickDispatchDragEnd: () => void
      onQuickDispatchShown: (callback: () => void) => () => void
      onQuickDispatchToggleDictation: (callback: () => void) => () => void
      quickDispatchDrainAttach: () => Promise<string[]>
      onQuickDispatchAttachPending: (callback: () => void) => () => void
      onQuickDispatchReset: (callback: () => void) => () => void
      setGlobalDispatchShortcut: (accelerator: string) => Promise<{ success: boolean; error?: string }>
    }
  }
}
