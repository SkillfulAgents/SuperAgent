import { MoonStar, X, Play } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, format } from 'date-fns'
import { Button } from '@renderer/components/ui/button'
import { apiFetch } from '@renderer/lib/api'
import { useMutation } from '@tanstack/react-query'

interface PendingWakeBannerProps {
  sessionId: string
  agentSlug: string
  wakeAt: string
  taskId: string
  note?: string
  readOnly?: boolean
}

/**
 * Bar shown above the composer while the session has a pending scheduled wake
 * (long sleep): when it will auto-resume, the agent's note-to-self, and
 * Wake now / Cancel actions.
 */
export function PendingWakeBanner({
  sessionId,
  agentSlug,
  wakeAt,
  taskId,
  note,
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
    <div
      className="mx-4 mb-2 flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
      data-testid="pending-wake-banner"
    >
      <MoonStar className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        This session will auto-resume{' '}
        <span className="font-medium text-foreground" title={format(wakeDate, 'PPpp')}>
          {formatDistanceToNow(wakeDate, { addSuffix: true })}
        </span>
        {note ? <> — &ldquo;{note}&rdquo;</> : null}
      </span>
      {!readOnly && (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            disabled={isPending}
            onClick={() => wakeNow.mutate()}
            data-testid="pending-wake-wake-now"
          >
            <Play className="h-3 w-3" />
            Wake now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            disabled={isPending}
            onClick={() => cancelWake.mutate()}
            data-testid="pending-wake-cancel"
          >
            <X className="h-3 w-3" />
            Cancel
          </Button>
        </span>
      )}
    </div>
  )
}
