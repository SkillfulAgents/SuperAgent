import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Globe } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
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

  const isCompleted = status === 'completed' || status === 'declined'

  return (
    <RequestItemShell
      title="Browser Input Request"
      icon={<Globe />}
      theme="blue"
      waitingText="Waiting for input"
      completed={
        isCompleted
          ? {
              icon: (
                <Globe
                  className={cn(
                    'h-4 w-4 shrink-0',
                    status === 'completed' ? 'text-green-500' : 'text-red-500'
                  )}
                />
              ),
              label: <span className="text-sm">Browser Input</span>,
              statusLabel: status === 'completed' ? 'Completed' : 'Cancelled',
              isSuccess: status === 'completed',
            }
          : null
      }
      readOnly={
        readOnly
          ? {
              description: (
                <>
                  <div className="pt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{message}</div>
                  <p className="pt-2 text-xs text-muted-foreground">
                    Click &apos;Done&apos; when you have completed the suggested step(s).
                  </p>
                </>
              ),
            }
          : false
      }
      error={error}
      data-testid={isCompleted ? 'browser-input-request-completed' : 'browser-input-request'}
      data-status={isCompleted ? status : undefined}
    >
      <p className="pt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{message}</p>
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

      <RequestItemActions>
        <Button
          onClick={handleChatWithAgent}
          loading={submittingAction === 'declining'}
          disabled={status === 'submitting'}
          size="sm"
          variant="outline"
          className="h-8 min-w-24 border-border text-foreground hover:bg-muted"
          data-testid="browser-input-chat-btn"
        >
          Dismiss
        </Button>

        <Button
          onClick={handleComplete}
          loading={submittingAction === 'completing'}
          disabled={status === 'submitting'}
          size="sm"
          className="h-8 min-w-24 bg-blue-600 text-white hover:bg-blue-700"
          data-testid="browser-input-complete-btn"
        >
          Done
        </Button>
      </RequestItemActions>
    </RequestItemShell>
  )
}
