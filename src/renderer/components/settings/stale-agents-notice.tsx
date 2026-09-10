import { useState } from 'react'
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { WorkingDots } from '@renderer/components/agents/status-indicators'
import { useStaleAgents } from '@renderer/hooks/use-stale-agents'

/**
 * Agents still on a pre-change container env, with one Restart all. Renders
 * from the host record alone and takes no copy from the tab that mounts it.
 * States, in the order the storyboards lock them: restarting, pending,
 * restarted, failed. Nothing when the host has no record.
 */
export function StaleAgentsNotice() {
  const { record, rows, lastRun, restartAll, isRestarting, restartError } = useStaleAgents()
  const [expanded, setExpanded] = useState(false)
  const restarted = lastRun?.filter((r) => r.status === 'restarted') ?? []
  if (!record && restarted.length === 0) return null

  const pending = rows.filter((r) => r.status === 'pending')
  const failed = rows.filter((r) => r.status === 'failed')
  const onRestart = () => {
    setExpanded(true)
    restartAll()
  }

  if (isRestarting) {
    const targets = rows.filter((r) => r.status !== 'skipped')
    return (
      <Notice
        tone="warning"
        action={<Button size="sm" variant="outline" disabled>Restarting…</Button>}
        details={
          <ul>
            {targets.map((r) => (
              <li key={r.slug} className="flex items-center gap-1">
                {r.status === 'restarted' && <Check className="h-3 w-3" />}
                {r.status === 'restarting' && <Loader2 className="h-3 w-3 animate-spin" />}
                <span className={r.status === 'restarting' ? 'italic' : undefined}>{r.name}</span>
              </li>
            ))}
          </ul>
        }
      >
        <p>Restarting {agentCount(targets.length)} one at a time.</p>
      </Notice>
    )
  }

  return (
    <div className="space-y-2">
      {pending.length > 0 && (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <Notice
            tone="warning"
            action={<Button size="sm" variant="outline" onClick={onRestart}>Restart all</Button>}
            details={
              <CollapsibleContent>
                <ul>
                  {pending.map((r) => (
                    <li key={r.slug} className="flex items-center gap-1.5">
                      {/* The sidebar's own vocabulary: animated dots for a mid-turn agent, a still dot for a running one. */}
                      {r.working ? <WorkingDots /> : <RunningDot />}
                      {r.name}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            }
          >
            <p>
              <Disclosure expanded={expanded}>
                {pending.length} running {pending.length === 1 ? 'agent' : 'agents'}
              </Disclosure>
              . Restart for changes to take effect.
            </p>
          </Notice>
        </Collapsible>
      )}
      {restarted.length > 0 && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          {agentCount(restarted.length)} restarted.
        </p>
      )}
      {failed.length > 0 && (
        failed.length === 1 ? (
          <Notice tone="error" action={<Button size="sm" variant="outline" onClick={onRestart}>Retry</Button>}>
            <p><span className="font-medium">{failed[0].name}</span> didn&apos;t restart: {firstLine(failed[0].error)}</p>
          </Notice>
        ) : (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <Notice
              tone="error"
              action={<Button size="sm" variant="outline" onClick={onRestart}>Retry</Button>}
              details={
                <CollapsibleContent>
                  {failed.map((r) => <p key={r.slug}>{r.name}: {firstLine(r.error)}</p>)}
                </CollapsibleContent>
              }
            >
              <p>
                <Disclosure expanded={expanded}>{agentCount(failed.length)}</Disclosure>{' '}
                didn&apos;t restart.
              </p>
            </Notice>
          </Collapsible>
        )
      )}
      {restartError && <p className="text-xs text-destructive" role="alert">{restartError}</p>}
    </div>
  )
}

function RunningDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" role="img" aria-label="running" />
}

/** Runtime errors arrive as multi-line dumps (stderr, stdout); the first line names the cause. */
function firstLine(error: string | undefined): string {
  return (error ?? '').split('\n')[0]
}

function agentCount(n: number): string {
  return `${n} ${n === 1 ? 'agent' : 'agents'}`
}

/** The settings tabs' inline notice block (llm-tab's yellow one, and the red one under credential inputs). */
function Notice({ tone, action, details, children }: {
  tone: 'warning' | 'error'
  action: React.ReactNode
  /** Grows below the first row, under the sentence. The first row never moves. */
  details?: React.ReactNode
  children: React.ReactNode
}) {
  const classes = tone === 'warning'
    ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500/90'
    : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
  const Icon = tone === 'warning' ? AlertTriangle : AlertCircle
  return (
    <div className={`rounded-md px-2.5 py-2 text-[11px] leading-relaxed ${classes}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 flex-1">{children}</div>
        <div className="shrink-0">{action}</div>
      </div>
      {details && <div className="pl-[22px] opacity-85">{details}</div>}
    </div>
  )
}

/** The count in the sentence is the trigger; Radix owns the open state and aria. */
function Disclosure({ expanded, children }: { expanded: boolean; children: React.ReactNode }) {
  return (
    <CollapsibleTrigger className="inline-flex items-center gap-0.5 font-medium underline decoration-dotted underline-offset-2">
      {children}
      {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
    </CollapsibleTrigger>
  )
}
