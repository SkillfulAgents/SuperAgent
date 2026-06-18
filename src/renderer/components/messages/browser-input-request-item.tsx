import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Globe } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
import { RequestError } from './request-error'
import { DeclineButton } from './decline-button'
import { useDraft } from '@renderer/context/drafts-context'
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
  const [, setSessionDraft] = useDraft<string>(`session:${sessionId}`)

  const submitBrowserInput = async (
    body: object,
    successStatus: RequestStatus,
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
      onComplete()
      return true
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed')
      setStatus('pending')
      setSubmittingAction(null)
      return false
    }
  }

  const handleComplete = () => submitBrowserInput({ toolUseId }, 'completed', 'completing')

  const handleDecline = async (reason?: string) => {
    const ok = await submitBrowserInput({ toolUseId, decline: true }, 'declined', 'declining')
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
        setSessionDraft(reason)
        setError(err instanceof Error ? err.message : 'Failed to send your reason to the agent')
      }
    }
  }

  const isCompleted = status === 'completed' || status === 'declined'

  return (
    <>
    <RequestItemShell
      title={message}
      subtitle="Click 'Done' when you have completed the suggested steps."
      theme="blue"
      sessionId={sessionId}
      agentSlug={agentSlug}
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
              statusLabel: status === 'completed' ? 'Completed' : 'Declined',
              isSuccess: status === 'completed',
            }
          : null
      }
      readOnly={readOnly ? {} : false}
      error={error}
      data-testid={isCompleted ? 'browser-input-request-completed' : 'browser-input-request'}
      data-status={isCompleted ? status : undefined}
    >
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
        <DeclineButton
          onDecline={handleDecline}
          disabled={status === 'submitting'}
          label="Decline"
          showIcon={false}
          size="xs"
          className="border-border text-foreground hover:bg-muted"
          data-testid="browser-input-decline-btn"
        />

        <Button
          onClick={handleComplete}
          loading={submittingAction === 'completing'}
          disabled={status === 'submitting'}
          size="xs"
          className="h-8 min-w-24 bg-blue-600 text-white hover:bg-blue-700"
          data-testid="browser-input-complete-btn"
        >
          Done
        </Button>
      </RequestItemActions>
    </RequestItemShell>
    {isCompleted && error && <RequestError message={error} />}
    </>
  )
}
