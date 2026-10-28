import { useCallback, useState } from 'react'
import { useLoginWindow, type LoginWindowOutcome } from '@renderer/hooks/use-login-window'
import { useMcpOAuthListener, type McpOAuthResult } from '@renderer/hooks/use-mcp-oauth-listener'

type McpLoginRequest = () => Promise<{ redirectUrl?: string | null; state?: string } | null>

/**
 * A login window for MCP sign-in. `open` takes a request that returns the
 * initiate response instead of a bare URL; the completion listener arms once
 * the window is on the sign-in page with this attempt's state, so a callback
 * from another tab or from a cancelled attempt is ignored.
 */
export function useMcpLoginWindow(onComplete: (result: McpOAuthResult) => void) {
  const loginWindow = useLoginWindow()
  const [state, setState] = useState<string>()
  useMcpOAuthListener(loginWindow.waiting && state !== undefined, onComplete, state)

  const { open: openLoginWindow } = loginWindow
  const open = useCallback(async (request: McpLoginRequest): Promise<LoginWindowOutcome> => {
    setState(undefined)
    let attemptState: string | undefined
    const outcome = await openLoginWindow(async () => {
      const result = await request()
      attemptState = result?.state
      return result?.redirectUrl
    })
    if (outcome === 'waiting') setState(attemptState)
    return outcome
  }, [openLoginWindow])

  return { ...loginWindow, open }
}
