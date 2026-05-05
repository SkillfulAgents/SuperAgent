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
  const { setAgent } = useSelection()

  useEffect(() => {
    if (!window.electronAPI?.onNavigateToAgent) {
      return
    }

    window.electronAPI.onNavigateToAgent((agentSlug, sessionId) => {
      setAgent(agentSlug, sessionId ? { kind: 'session', id: sessionId } : { kind: 'home' })
    })

    return () => {
      window.electronAPI?.removeNavigateToAgent?.()
    }
  }, [setAgent])

  return <>{children}</>
}
