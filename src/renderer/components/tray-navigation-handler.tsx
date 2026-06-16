import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
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
  const navigate = useNavigate()

  useEffect(() => {
    if (!window.electronAPI?.onNavigateToAgent) {
      return
    }

    window.electronAPI.onNavigateToAgent((agentSlug, sessionId) => {
      setAgent(agentSlug, sessionId ? { kind: 'session', id: sessionId } : { kind: 'home' })
      void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
    })

    return () => {
      window.electronAPI?.removeNavigateToAgent?.()
    }
  }, [setAgent, navigate])

  return <>{children}</>
}
