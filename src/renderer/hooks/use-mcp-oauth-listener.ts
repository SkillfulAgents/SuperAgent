import { useEffect, useRef } from 'react'

type McpOAuthResult = { success: boolean; error?: string }

/**
 * Listen for MCP OAuth completion from the OS browser (Electron IPC) or the
 * popup window (web postMessage). Only listens while `active` is true; the
 * callback ref is kept fresh so a changing closure does not trigger
 * re-registration.
 */
export function useMcpOAuthListener(active: boolean, onComplete: (result: McpOAuthResult) => void): void {
  const callbackRef = useRef(onComplete)
  callbackRef.current = onComplete

  useEffect(() => {
    if (!active) return

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'mcp-oauth-callback') {
        callbackRef.current({ success: !!event.data.success, error: event.data.error })
      }
    }

    window.addEventListener('message', handleMessage)

    if (window.electronAPI) {
      window.electronAPI.onMcpOAuthCallback((params) => {
        callbackRef.current({ success: !!params.success, error: params.error ?? undefined })
      })
    }

    return () => {
      window.removeEventListener('message', handleMessage)
      window.electronAPI?.removeMcpOAuthCallback()
    }
  }, [active])
}
