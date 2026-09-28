import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'

export interface SavedLogin {
  id: string
  name: string
  site: string
  capturedAt: string
}

export interface SavedLogins {
  /** null while loading; [] when there are none or the lookup failed. */
  logins: SavedLogin[] | null
  applyingId: string | null
  applied: boolean
  error: string | null
  apply: (credentialId: string) => Promise<void>
}

/** The user's saved logins for a sign-in request's site, shared by the chat card and the browser panel. */
export function useSavedLogins(agentSlug: string, sessionId: string, toolUseId: string | null, enabled: boolean): SavedLogins {
  const [logins, setLogins] = useState<SavedLogin[] | null>(null)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionPath = `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}`

  useEffect(() => {
    setLogins(enabled && toolUseId ? null : [])
    setApplied(false)
    setError(null)
    if (!enabled || !toolUseId) return
    const controller = new AbortController()
    void apiFetch(`${sessionPath}/saved-browser-logins?toolUseId=${encodeURIComponent(toolUseId)}`, {
      signal: controller.signal,
    }).then(async (response) => {
      const result = response.ok ? await response.json() as { logins?: SavedLogin[] } : {}
      setLogins(result.logins ?? [])
    }).catch(() => {
      if (!controller.signal.aborted) setLogins([])
    })
    return () => controller.abort()
  }, [sessionPath, toolUseId, enabled])

  const apply = async (credentialId: string) => {
    if (!toolUseId) return
    setApplyingId(credentialId)
    setError(null)
    try {
      const response = await apiFetch(`${sessionPath}/use-saved-browser-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolUseId, credentialId }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string; linked?: boolean }
      if (!response.ok) throw new Error(result.error || 'Could not apply the saved login')
      if (result.linked === false) toast.error('Login applied, but it could not be linked to this agent')
      setApplied(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not apply the saved login')
    } finally {
      setApplyingId(null)
    }
  }

  return { logins, applyingId, applied, error, apply }
}
