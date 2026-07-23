import { Loader2, AlertCircle, AlertTriangle, X } from 'lucide-react'
import { useAgent, type useStartAgent } from '@renderer/hooks/use-agents'
import { useMountWarnings } from '@renderer/hooks/use-mount-warnings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'

interface AgentBannersProps {
  slug: string
  startAgent: ReturnType<typeof useStartAgent>
}

/**
 * Agent-level banners (image pull progress, start error, health warnings,
 * missing mounts) rendered by the shared AgentShell layout above the `<Outlet/>`,
 * so they appear on every agent sub-view exactly as they did when the agent body
 * owned them. `startAgent` is shared with AgentHeader's start button so the error
 * banner reflects that exact mutation.
 */
export function AgentBanners({ slug, startAgent }: AgentBannersProps) {
  const { data: agent } = useAgent(slug)
  const { warning: mountWarning, dismiss: dismissMountWarning } = useMountWarnings(slug)
  const { data: runtimeStatus } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const progress = readiness?.pullProgress
  const showProgress =
    !!progress &&
    (readiness?.status === 'PULLING_IMAGE' || readiness?.status === 'CHECKING')

  return (
    <>
      {/* Image pull / runtime install progress */}
      {showProgress && progress && (
        <div className="shrink-0 border-b bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>
              {readiness?.status === 'PULLING_IMAGE'
                ? `Pulling agent image... ${progress.status}`
                : progress.status}
            </span>
            {progress.percent != null && (
              <span>({progress.percent}%)</span>
            )}
          </div>
          {progress.percent != null && (
            <div className="mt-1 h-1 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Start error banner */}
      {startAgent.isError && (
        <div className="shrink-0 border-b bg-destructive/10 px-4 py-2">
          {/* Start failures may carry multi-line remediation steps (e.g. an
              unreachable local model naming the bind to change), so keep the
              newlines and top-align the icon against the first line. Single-line
              messages are unaffected. */}
          <div className="flex items-start gap-2 text-xs text-destructive select-text">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="whitespace-pre-line">
              Failed to start agent: {startAgent.error.message}
            </span>
          </div>
        </div>
      )}

      {/* Health warning banner */}
      {agent?.healthWarnings?.map((warning) => (
        <div
          key={warning.checkName}
          className={`shrink-0 border-b px-4 py-2 ${
            warning.status === 'critical'
              ? 'bg-destructive/10'
              : 'bg-yellow-500/10'
          }`}
        >
          <div className={`flex items-center gap-2 text-xs select-text ${
            warning.status === 'critical'
              ? 'text-destructive'
              : 'text-yellow-700 dark:text-yellow-400'
          }`}>
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{warning.message}</span>
          </div>
        </div>
      ))}

      {/* Missing mount warning banner */}
      {mountWarning && mountWarning.missingMounts.length > 0 && (
        <div className="shrink-0 border-b bg-yellow-500/10 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-yellow-700 dark:text-yellow-400 select-text">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="flex-1">
              Some mounted folders were not found and have been skipped: {mountWarning.missingMounts.map((m) => m.folderName).join(', ')}
              {mountWarning.hint ? ` — ${mountWarning.hint}` : ''}
            </span>
            <button
              onClick={dismissMountWarning}
              className="text-yellow-700 dark:text-yellow-400 hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
