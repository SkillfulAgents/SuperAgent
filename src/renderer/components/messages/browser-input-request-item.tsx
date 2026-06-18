import { Globe } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
import { RequestError } from './request-error'
import { DeclineButton } from './decline-button'
import { useBrowserInputActions } from '@renderer/hooks/use-browser-input-actions'
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

export function BrowserInputRequestItem({
  toolUseId,
  message,
  requirements,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: BrowserInputRequestItemProps) {
  const { status, submittingAction, error, complete, decline } = useBrowserInputActions({
    agentSlug,
    sessionId,
    onResolved: onComplete,
  })

  // `requirements` is typed string[] but originates from model tool input, so a
  // malformed value (e.g. a bare string) can reach here. Normalize to an array
  // before any `.length`/`.map` so a bad payload can't throw.
  const safeRequirements = Array.isArray(requirements) ? requirements : []

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
      {safeRequirements.length > 0 && (
        <div className="pt-4">
          <div className="rounded-md border border-border bg-white p-3 dark:bg-background">
            <ul className="space-y-1.5">
              {safeRequirements.map((req, i) => (
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
          onDecline={(reason) => decline(toolUseId, reason)}
          disabled={status === 'submitting'}
          label="Decline"
          showIcon={false}
          size="xs"
          className="border-border text-foreground hover:bg-muted"
          data-testid="browser-input-decline-btn"
        />

        <Button
          onClick={() => complete(toolUseId)}
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
