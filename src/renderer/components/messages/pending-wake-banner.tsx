import { useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, format } from 'date-fns'
import { Button } from '@renderer/components/ui/button'
import { apiFetch } from '@renderer/lib/api'

interface PendingWakeBannerProps {
  sessionId: string
  agentSlug: string
  wakeAt: string
  taskId: string
  note?: string
  /** The agent's one line for the user; wakes scheduled before it existed fall back to the note. */
  summary?: string
  readOnly?: boolean
}

/**
 * Card shown above the composer while the session has a pending scheduled wake
 * (long sleep): when it will auto-resume, what the agent is waiting on, and
 * Cancel / Run now actions. Styled to match `StaleSessionNotice`.
 */
export function PendingWakeBanner({
  sessionId,
  agentSlug,
  wakeAt,
  taskId,
  note,
  summary,
  readOnly,
}: PendingWakeBannerProps) {
  const queryClient = useQueryClient()

  const invalidateSession = () => {
    queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
    queryClient.invalidateQueries({ queryKey: ['sessions', agentSlug] })
  }

  const wakeNow = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}/run-now`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to wake session')
      }
      return res.json()
    },
    onSuccess: invalidateSession,
  })

  const cancelWake = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/scheduled-tasks/${taskId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) {
        throw new Error('Failed to cancel scheduled resume')
      }
    },
    onSuccess: invalidateSession,
  })

  const wakeDate = new Date(wakeAt)
  const isPending = wakeNow.isPending || cancelWake.isPending

  return (
    <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl bg-muted/80 p-4 backdrop-blur-md"
        data-testid="pending-wake-banner"
      >
        <div className="flex min-w-0 grow basis-40 flex-col gap-0.5">
          <p className="line-clamp-2 text-sm font-medium" data-testid="pending-wake-summary">
            {summary || note || 'This conversation will pick back up on its own.'}
          </p>
          <p className="text-xs text-muted-foreground">
            Auto-resumes{' '}
            <span title={format(wakeDate, 'PPpp')}>
              {formatDistanceToNow(wakeDate, { addSuffix: true })}
            </span>
          </p>
        </div>
        {!readOnly && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => cancelWake.mutate()}
              data-testid="pending-wake-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              loading={wakeNow.isPending}
              disabled={isPending}
              onClick={() => wakeNow.mutate()}
              data-testid="pending-wake-wake-now"
            >
              Run now
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
