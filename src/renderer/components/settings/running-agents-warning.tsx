import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  useRunningAgents,
  useRunningAgentsAction,
  type RunningAgentsAction,
} from '@renderer/hooks/use-running-agents'

interface RunningAgentsWarningProps {
  children: ReactNode
  runningAgentIds?: string[]
  action: RunningAgentsAction
  actionLabel: string
}

/** Shared warning for settings that affect containers which are already running. */
export function RunningAgentsWarning({
  children,
  runningAgentIds,
  action,
  actionLabel,
}: RunningAgentsWarningProps) {
  const agents = useRunningAgents(runningAgentIds)
  const actionMutation = useRunningAgentsAction(action)

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-yellow-500/20 bg-yellow-500/10 p-3 text-yellow-700 dark:text-yellow-400 sm:flex-row sm:items-start"
      data-testid="running-agents-warning"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm leading-relaxed">{children}</p>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Running agents</p>
          <ul className="flex flex-wrap gap-1.5" aria-label="Running agents">
            {agents.map((agent) => (
              <li
                key={agent.id}
                className="rounded-md border border-yellow-500/20 bg-background/70 px-2 py-1 text-xs text-foreground"
              >
                {agent.name}
              </li>
            ))}
          </ul>
        </div>
        {actionMutation.error && (
          <p className="text-xs font-medium text-destructive" role="alert">
            {actionMutation.error.message}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0 self-start"
        loading={actionMutation.isPending}
        onClick={() => actionMutation.mutate()}
      >
        {actionMutation.isPending
          ? action === 'restart' ? 'Restarting…' : 'Stopping…'
          : actionLabel}
      </Button>
    </div>
  )
}
