import type { ImagePullProgress } from '@shared/lib/container/types'

/** Compact phase label + optional download bar for runtime install/start. */
export function RuntimeProvisionProgress({
  progress,
}: {
  progress: Pick<ImagePullProgress, 'status' | 'percent'> | null | undefined
}) {
  if (!progress) return null
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {progress.status}
        {progress.percent != null ? ` (${progress.percent}%)` : ''}
      </p>
      {progress.percent != null && (
        <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
    </div>
  )
}
