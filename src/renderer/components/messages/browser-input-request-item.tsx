import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Globe, Check, Loader2, MessageSquare } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { RequestTitleChip } from './request-title-chip'
import { cn } from '@shared/lib/utils/cn'

interface BrowserInputRequestItemProps {
  toolUseId: string
  message: string
  requirements: string[]
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type SubmittingAction = 'completing' | 'declining'
type RequestStatus = 'pending' | 'submitting' | 'completed' | 'declined'

export function BrowserInputRequestItem({
  toolUseId,
  message,
  requirements,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: BrowserInputRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [submittingAction, setSubmittingAction] = useState<SubmittingAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submitBrowserInput = async (body: object, successStatus: RequestStatus, action: SubmittingAction) => {
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
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed')
      setStatus('pending')
      setSubmittingAction(null)
    }
  }

  const handleComplete = () => submitBrowserInput({ toolUseId }, 'completed', 'completing')

  const handleChatWithAgent = () =>
    submitBrowserInput(
      { toolUseId, decline: true, declineReason: 'User wants to chat with the agent' },
      'declined',
      'declining'
    )

  if (status === 'completed' || status === 'declined') {
    return (
      <div className="border rounded-md bg-muted/30 shadow-md text-sm" data-testid="browser-input-request-completed" data-status={status}>
        <div className="flex items-center gap-2 px-3 py-2">
          <Globe
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'completed' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="text-sm">Browser Input</span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'completed' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'completed' ? 'Completed' : 'Cancelled'}
          </span>
        </div>
      </div>
    )
  }

  if (readOnly) {
    return (
      <div className="border rounded-md bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-3">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<Globe />}>
              Browser Input Needed
            </RequestTitleChip>
            <div className="text-xs text-blue-700 dark:text-blue-300 mt-0.5 whitespace-pre-line">{message}</div>
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for input</span>
        </div>
      </div>
    )
  }

  return (
    <div className="border rounded-md bg-muted/30 shadow-md text-sm" data-testid="browser-input-request">
      <div className="p-3">
        <div className="flex-1 min-w-0 space-y-3">
          <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<Globe />}>
            Browser Input Needed
          </RequestTitleChip>

          <p className="text-blue-800 dark:text-blue-200 whitespace-pre-line">{message}</p>

          {requirements.length > 0 && (
            <div className="rounded-md bg-blue-100/50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 p-3 space-y-2">
              <div className="text-xs font-medium text-blue-700 dark:text-blue-300 uppercase tracking-wide">Requirements</div>
              <ul className="space-y-1.5">
                {requirements.map((req, i) => (
                  <li key={i} className="flex items-start gap-2 text-blue-800 dark:text-blue-200">
                    <span className="text-blue-500 mt-0.5 shrink-0 text-xs">{i + 1}.</span>
                    <span>{req}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleComplete}
              disabled={status === 'submitting'}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="browser-input-complete-btn"
            >
              {submittingAction === 'completing' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Complete</span>
            </Button>

            <Button
              onClick={handleChatWithAgent}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className="border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
              data-testid="browser-input-chat-btn"
            >
              {submittingAction === 'declining' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MessageSquare className="h-4 w-4" />
              )}
              <span className="ml-1">Chat with agent</span>
            </Button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
