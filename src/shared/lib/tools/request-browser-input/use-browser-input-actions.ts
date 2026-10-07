import { useEffect, useRef } from 'react'
import { useMutation, useMutationState, useQueryClient, type MutationState } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { appendToSessionDraft, useDraftsStore } from '@renderer/context/drafts-context'

export type BrowserInputStatus = 'pending' | 'submitting' | 'completed' | 'declined'
type SubmittingAction = 'completing' | 'declining'

interface UseBrowserInputActionsArgs {
  agentSlug: string
  sessionId: string
  toolUseId: string | null
  /** Called with the toolUseId once a request resolves (completed or declined) so the surface can remove it. */
  onResolved: (toolUseId: string) => void
}

const MUTATION_KEY = ['browser-input-action'] as const

interface BrowserInputAction {
  agentSlug: string
  sessionId: string
  toolUseId: string
  action: SubmittingAction
  reason?: string
}

interface BrowserInputResult {
  status: 'completed' | 'declined'
  error: string | null
}

/**
 * One submission state per agent/session/request, observed by both the thread
 * card and the browser tray. The tray stays mounted across requests, so its
 * status must follow the request id rather than the component's lifetime.
 *
 * Declining with a reason stops the browser work via `complete-browser-input`,
 * then posts the reason to `/messages` so the main agent resumes and acts on the
 * steer. If that send fails the reason is appended to the session composer draft
 * so it is never lost.
 */
export function useBrowserInputActions({ agentSlug, sessionId, toolUseId, onResolved }: UseBrowserInputActionsArgs) {
  const queryClient = useQueryClient()
  const drafts = useDraftsStore()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  const mutation = useMutation<BrowserInputResult, Error, BrowserInputAction>({
    mutationKey: MUTATION_KEY,
    retry: false,
    // Local API requests still work when the browser reports no internet.
    networkMode: 'always',
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ agentSlug, sessionId, toolUseId, action, reason }) => {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/complete-browser-input`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, ...(action === 'declining' ? { decline: true } : {}) }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Request failed')
      }

      let error: string | null = null
      if (action === 'declining' && reason) {
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
          // Read the draft at failure time, including edits made during the request.
          appendToSessionDraft(drafts, sessionId, reason, { prepend: false })
          error = err instanceof Error ? err.message : 'Failed to send your reason to the agent'
        }
      }

      return { status: action === 'completing' ? 'completed' : 'declined', error }
    },
  })

  // Subscribe to a stable key, then select by identity during render. Switching
  // requests (even while an older response is in flight) immediately selects its
  // own state, with no reset effect or stale submission flag to carry over.
  const states = useMutationState({
    filters: { mutationKey: MUTATION_KEY },
    select: (entry) => entry.state as MutationState<BrowserInputResult, Error, BrowserInputAction>,
  })
  const matchesRequest = (action: BrowserInputAction | undefined) =>
    action?.agentSlug === agentSlug && action.sessionId === sessionId && action.toolUseId === toolUseId
  const state = states.filter((entry) => matchesRequest(entry.variables)).at(-1)
  const status: BrowserInputStatus = state?.status === 'pending'
    ? 'submitting'
    : state?.data?.status ?? 'pending'
  const submittingAction = status === 'submitting' ? state?.variables?.action ?? null : null
  const error = state?.error?.message ?? state?.data?.error ?? null
  const isResolved = status === 'completed' || status === 'declined'

  useEffect(() => {
    if (isResolved && toolUseId) onResolvedRef.current(toolUseId)
  }, [isResolved, agentSlug, sessionId, toolUseId])

  const submit = async (action: SubmittingAction, reason?: string): Promise<boolean> => {
    if (!toolUseId) return false
    // Read the cache synchronously: another surface can click before React has
    // rendered its disabled button. A settled request also cannot be sent twice.
    const latest = queryClient.getMutationCache().findAll({
      mutationKey: MUTATION_KEY,
      predicate: (entry) => matchesRequest(entry.state.variables as BrowserInputAction | undefined),
    }).at(-1)
    if (latest?.state.status === 'pending' || latest?.state.status === 'success') return false

    try {
      await mutation.mutateAsync({ agentSlug, sessionId, toolUseId, action, reason })
      return true
    } catch {
      // The shared mutation state exposes the error and makes both surfaces retryable.
      return false
    }
  }

  const complete = () => submit('completing')
  const decline = (reason?: string) => submit('declining', reason)

  return { status, submittingAction, error, complete, decline }
}
