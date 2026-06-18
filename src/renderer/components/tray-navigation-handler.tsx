import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'

interface TrayNavigationHandlerProps {
  children: React.ReactNode
}

/**
 * Listens for navigation commands from the system tray and updates the selection context.
 * Must be rendered inside SelectionProvider.
 */
export function TrayNavigationHandler({ children }: TrayNavigationHandlerProps) {
  const navigate = useNavigate()

  useEffect(() => {
    if (!window.electronAPI?.onNavigateToAgent) {
      return
    }

    window.electronAPI.onNavigateToAgent((agentSlug, sessionId) => {
      if (sessionId) {
        void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agentSlug, sessionId } })
      } else {
        void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
      }
    })

    return () => {
      window.electronAPI?.removeNavigateToAgent?.()
    }
  }, [navigate])

  return <>{children}</>
}
