import { useEffect, useRef } from 'react'

type McpOAuthResult = { success: boolean; error?: string }
type McpOAuthCallbackMessage = {
  type?: unknown
  success?: unknown
  error?: unknown
}

const MCP_OAUTH_CALLBACK_CHANNEL = 'mcp-oauth-callback'
const MCP_OAUTH_CALLBACK_STORAGE_KEY = 'superagent.mcp-oauth-callback'

function parseMcpOAuthResult(data: unknown): McpOAuthResult | null {
  if (!data || typeof data !== 'object') return null

  const message = data as McpOAuthCallbackMessage
  if (message.type !== 'mcp-oauth-callback') return null

  return {
    success: !!message.success,
    error: typeof message.error === 'string' ? message.error : undefined,
  }
}

/**
 * Listen for MCP OAuth completion from the OS browser (Electron IPC) or the
 * popup window. Some providers isolate the popup with Cross-Origin-Opener-Policy
 * and sever `window.opener`, so web mode listens on postMessage, BroadcastChannel,
 * and localStorage's cross-window storage event.
 */
export function useMcpOAuthListener(active: boolean, onComplete: (result: McpOAuthResult) => void): void {
  const callbackRef = useRef(onComplete)
  callbackRef.current = onComplete

  useEffect(() => {
    if (!active) return

    let completed = false
    const completeOnce = (data: unknown) => {
      const result = parseMcpOAuthResult(data)
      if (!result || completed) return

      completed = true
      callbackRef.current(result)
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      completeOnce(event.data)
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== MCP_OAUTH_CALLBACK_STORAGE_KEY || !event.newValue) return
      try {
        completeOnce(JSON.parse(event.newValue))
      } catch {
        // Ignore unrelated or malformed storage writes.
      }
    }

    window.addEventListener('message', handleMessage)
    window.addEventListener('storage', handleStorage)

    let broadcastChannel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      broadcastChannel = new BroadcastChannel(MCP_OAUTH_CALLBACK_CHANNEL)
      broadcastChannel.addEventListener('message', (event) => {
        completeOnce(event.data)
      })
    }

    let unsubscribe: (() => void) | undefined
    if (window.electronAPI) {
      unsubscribe = window.electronAPI.onMcpOAuthCallback((params) => {
        completeOnce({
          type: 'mcp-oauth-callback',
          success: params.success,
          error: params.error ?? undefined,
        })
      })
    }

    return () => {
      window.removeEventListener('message', handleMessage)
      window.removeEventListener('storage', handleStorage)
      broadcastChannel?.close()
      unsubscribe?.()
    }
  }, [active])
}
