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
  const { selectAgent } = useSelection()

  useEffect(() => {
    // Only set up listener in Electron environment
    if (!window.electronAPI?.onNavigateToAgent) {
      return
    }

    window.electronAPI.onNavigateToAgent((agentSlug) => {
      selectAgent(agentSlug)
    })

    return () => {
      window.electronAPI?.removeNavigateToAgent?.()
    }
  }, [selectAgent])

  return <>{children}</>
}
