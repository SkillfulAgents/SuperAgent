import { Rocket, CheckCircle2 } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps } from './types'
import { engageAutopilotDef } from '@shared/lib/tool-definitions/engage-autopilot'

/**
 * Renderer for the engage_autopilot tool call — the visible moment a session
 * crossed from interactive preflight into autonomous execution. Shows the goal
 * contract (what the watchdog will judge against) rather than raw JSON.
 */
function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { goal, success_criteria, max_iterations } = engageAutopilotDef.parseInput(input)

  return (
    <div className="space-y-3">
      {goal && (
        <div className="space-y-1">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
            Goal
          </span>
          <div className="text-xs">{goal}</div>
        </div>
      )}

      {Array.isArray(success_criteria) && success_criteria.length > 0 && (
        <div className="space-y-1">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
            Success criteria
          </span>
          <ul className="ml-1 space-y-0.5">
            {success_criteria.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-purple-500" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {max_iterations != null && (
        <div className="text-xs text-muted-foreground">
          Up to {max_iterations} autonomous continuations before escalating.
        </div>
      )}

      {result && (
        <div
          className={
            isError
              ? 'bg-background text-red-800 dark:text-red-200 rounded p-2 text-xs'
              : 'bg-background text-purple-800 dark:text-purple-200 rounded p-2 text-xs'
          }
        >
          {result}
        </div>
      )}
    </div>
  )
}

export const engageAutopilotRenderer: ToolRenderer = {
  displayName: 'Engage Autopilot',
  icon: Rocket,
  getSummary: engageAutopilotDef.getSummary,
  ExpandedView,
}
