import { useState } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { useDraft } from '@renderer/context/drafts-context'

export type BrowserInputStatus = 'pending' | 'submitting' | 'completed' | 'declined'
type SubmittingAction = 'completing' | 'declining'

interface UseBrowserInputActionsArgs {
  agentSlug: string
  sessionId: string
  /** Called with the toolUseId once a request resolves (completed or declined) so the surface can remove it. */
  onResolved: (toolUseId: string) => void
}

/**
 * Shared complete/decline behavior for a browser-input request. Used by both the
 * in-chat request card (`browser-input-request-item.tsx`) and the browser-tray
 * action bar (`browser-tray-content.tsx`), which render different layouts but
 * drive the same two endpoints.
 *
 * Declining with a reason stops the browser work via `complete-browser-input`,
 * then posts the reason to `/messages` so the main agent resumes and acts on the
 * steer. If that send fails the reason is appended to the session composer draft
 * so it is never lost.
 */
export function useBrowserInputActions({ agentSlug, sessionId, onResolved }: UseBrowserInputActionsArgs) {
  const [status, setStatus] = useState<BrowserInputStatus>('pending')
  const [submittingAction, setSubmittingAction] = useState<SubmittingAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sessionDraft, setSessionDraft] = useDraft<string>(`session:${sessionId}`)

  const submit = async (
    body: { toolUseId: string } & Record<string, unknown>,
    successStatus: BrowserInputStatus,
    action: SubmittingAction
  ): Promise<boolean> => {
    setStatus('submitting')
    setSubmittingAction(action)
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/complete-browser-input`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Request failed')
      }

      setStatus(successStatus)
      onResolved(body.toolUseId)
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed')
      setStatus('pending')
      setSubmittingAction(null)
      return false
    }
  }

  const complete = (toolUseId: string) => submit({ toolUseId }, 'completed', 'completing')

  const decline = async (toolUseId: string, reason?: string) => {
    const ok = await submit({ toolUseId, decline: true }, 'declined', 'declining')
    if (ok && reason) {
      try {
        const res = await apiFetch(
          `/api/agents/${agentSlug}/sessions/${sessionId}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: reason }),
          }
        )
        if (!res.ok) throw new Error('Failed to send your reason to the agent')
      } catch (err: unknown) {
        // Preserve any text already in the composer instead of overwriting it.
        setSessionDraft(sessionDraft ? `${sessionDraft}\n${reason}` : reason)
        setError(err instanceof Error ? err.message : 'Failed to send your reason to the agent')
      }
    }
  }

  return { status, submittingAction, error, complete, decline }
}
