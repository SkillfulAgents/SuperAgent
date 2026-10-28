import { useEffect } from 'react'
import { apiFetch } from '@renderer/lib/api'

const INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

export function useKeepAlive(agentSlug: string): void {
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState === 'hidden') return
      apiFetch(`/api/agents/${agentSlug}/keep-alive`, { method: 'POST' }).catch(
        () => {}
      )
    }

    ping()
    const id = setInterval(ping, INTERVAL_MS)
    // Browser timers are throttled while a tab is backgrounded. Refresh the
    // lease immediately when the dashboard becomes visible again instead of
    // waiting for whichever interval tick the browser next schedules.
    document.addEventListener('visibilitychange', ping)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', ping)
    }
  }, [agentSlug])
}
