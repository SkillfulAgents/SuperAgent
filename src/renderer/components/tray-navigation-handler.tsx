import { useEffect } from 'react'
import { useSelection } from '../context/selection-context'

interface TrayNavigationHandlerProps {
  children: React.ReactNode
}

/**
 * Listens for navigation commands from the system tray and updates the selection context.
 * Must be rendered inside SelectionProvider.
 */
export function TrayNavigationHandler({ children }: TrayNavigationHandlerProps) {
  const { selectAgent, selectAgentSession } = useSelection()

  useEffect(() => {
    if (!window.electronAPI?.onNavigateToAgent) {
      return
    }

    window.electronAPI.onNavigateToAgent((agentSlug) => {
      selectAgent(agentSlug)
    })

    window.electronAPI.onNavigateToAgentSession?.((agentSlug, sessionId) => {
      selectAgentSession(agentSlug, sessionId)
    })

    return () => {
      window.electronAPI?.removeNavigateToAgent?.()
    }
  }, [selectAgent, selectAgentSession])

  return <>{children}</>
}
