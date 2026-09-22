import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { WorkingDots } from '@renderer/components/agents/status-indicators'
import { useStaleAgents } from '@renderer/hooks/use-stale-agents'

/**
 * Agents still running on a container env that a setting change replaced, with
 * one Stop all. Each starts fresh on its next message, so stopping is the whole
 * fix. Nothing when the host lists none and this mount stopped none.
 */
export function StaleAgentsNotice() {
  const { rows, stopAll, isStopping, stoppedCount } = useStaleAgents()
  const [expanded, setExpanded] = useState(false)
  if (rows.length === 0 && stoppedCount === 0) return null
  const one = rows.length === 1

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          {/* The settings tabs' inline notice block (llm-tab's yellow one). */}
          <div className="rounded-md bg-yellow-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-yellow-700 dark:text-yellow-500/90">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <p className="min-w-0 flex-1">
                {/* The count in the sentence is the trigger; Radix owns the open state and aria. */}
                <CollapsibleTrigger className="inline-flex items-center gap-0.5 font-medium underline decoration-dotted underline-offset-2">
                  {rows.length} running {one ? 'agent' : 'agents'}
                  {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </CollapsibleTrigger>
                {one
                  ? ' still uses the old settings. Stop it and it starts fresh on its next message.'
                  : ' still use the old settings. Stop them and they start fresh on their next message.'}
              </p>
              <Button size="sm" variant="outline" className="shrink-0" disabled={isStopping} onClick={stopAll}>
                {isStopping ? 'Stopping…' : 'Stop all'}
              </Button>
            </div>
            <CollapsibleContent>
              <ul className="pl-[22px] opacity-85">
                {rows.map((r) => (
                  <li key={r.slug} className="flex items-center gap-1.5">
                    {/* The sidebar's own vocabulary: animated dots for a mid-turn agent, a still dot for a running one. */}
                    {r.working ? <WorkingDots /> : <RunningDot />}
                    {r.name}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
      {stoppedCount > 0 && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          {stoppedCount} {stoppedCount === 1 ? 'agent' : 'agents'} stopped.
        </p>
      )}
    </div>
  )
}

function RunningDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" role="img" aria-label="running" />
}
