import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Globe, Loader2 } from 'lucide-react'
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="browser-input-request-completed" data-status={status}>
        <div className="flex items-center gap-2 p-4">
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<Globe />}>
              Browser Input Request
            </RequestTitleChip>
            <div className="pt-8 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{message}</div>
            <p className="pt-2 text-xs text-muted-foreground">
              Click &apos;Done&apos; when you have completed the suggested step(s).
            </p>
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for input</span>
        </div>
      </div>
    )
  }

  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="browser-input-request">
      <div className="p-4">
        <div className="flex-1 min-w-0">
          <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<Globe />}>
            Browser Input Request
          </RequestTitleChip>

          <p className="pt-8 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{message}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Click &apos;Done&apos; when you have completed the suggested step(s).
          </p>

          {requirements.length > 0 && (
            <div className="pt-4">
              <div className="rounded-md border border-border bg-white p-3 dark:bg-background">
                <ul className="space-y-1.5">
                  {requirements.map((req, i) => (
                    <li key={i} className="flex items-start gap-2 text-foreground">
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{i + 1}.</span>
                      <span>{req}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-8">
            <Button
              onClick={handleChatWithAgent}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className="h-8 min-w-24 border-border text-foreground hover:bg-muted"
              data-testid="browser-input-chat-btn"
            >
              {submittingAction === 'declining' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <span>Dismiss</span>
              )}
              {submittingAction === 'declining' ? <span>Dismiss</span> : null}
            </Button>

            <Button
              onClick={handleComplete}
              disabled={status === 'submitting'}
              size="sm"
              className="h-8 min-w-24 bg-blue-600 text-white hover:bg-blue-700"
              data-testid="browser-input-complete-btn"
            >
              {submittingAction === 'completing' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <span>Done</span>
              )}
              {submittingAction === 'completing' ? <span>Done</span> : null}
            </Button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
