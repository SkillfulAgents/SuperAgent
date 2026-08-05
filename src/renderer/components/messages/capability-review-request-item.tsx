import { apiFetch } from '@renderer/lib/api'
import { useMemo, useState } from 'react'
import { GitBranch, Bot, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'
import { parseWorkflowScript } from '@shared/lib/workflows/workflow-script-parser'
import type { ParsedScript } from '@shared/lib/workflows/workflow-schemas'
import { DeclineButton } from './decline-button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'

interface CapabilityReviewRequestItemProps {
  toolUseId: string
  capability: 'subagents' | 'workflows'
  toolName: string
  input: Record<string, unknown>
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'approved' | 'blocked'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// Pre-flight summary of the workflow script: name, description, phases and
// agent-call sites. Workflow internals never pass back through the permission
// layer once launched, so this parse IS the review surface.
function useParsedWorkflow(capability: string, input: Record<string, unknown>): ParsedScript | null {
  return useMemo(() => {
    if (capability !== 'workflows') return null
    const script = str(input.script)
    if (!script) return null
    try {
      return parseWorkflowScript(script)
    } catch {
      return null
    }
  }, [capability, input])
}

export function CapabilityReviewRequestItem({
  toolUseId,
  capability,
  input,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: CapabilityReviewRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [runMenuOpen, setRunMenuOpen] = useState(false)

  const isWorkflow = capability === 'workflows'
  const parsed = useParsedWorkflow(capability, input)

  const workflowName = parsed?.name ?? str(input.name)
  const subagentType = str(input.subagent_type)
  const description = str(input.description) ?? parsed?.description ?? undefined
  const prompt = str(input.prompt)

  const submit = async (body: Record<string, unknown>, nextStatus: 'approved' | 'blocked') => {
    setStatus('submitting')
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/capability-review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, capability, ...body }),
        }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Request failed (${response.status})`)
      }
      setStatus(nextStatus)
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit decision')
      setStatus('pending')
    }
  }

  const handleRun = (scope: 'once' | 'session') => submit({ scope }, 'approved')
  const handleBlock = (reason?: string) => submit({ decline: true, declineReason: reason }, 'blocked')

  const isCompleted = status === 'approved' || status === 'blocked'
  const Icon = isWorkflow ? GitBranch : Bot

  const title = isWorkflow
    ? workflowName
      ? `Run the workflow "${workflowName}"?`
      : 'Run this workflow?'
    : subagentType
      ? `Launch a ${subagentType} subagent?`
      : 'Launch a subagent?'

  const subtitle = isWorkflow
    ? 'Workflows can fan out into many agents. Review the plan before it runs — once launched, its internal agents run without further approval.'
    : 'Subagents run autonomously and use additional tokens.'

  const detailBlock = (
    <div className="pt-4 space-y-2">
      {description && (
        <p className="text-sm text-foreground/85">{description}</p>
      )}
      {isWorkflow && parsed && parsed.phases.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border bg-white dark:bg-background p-2">
          <p className="mb-1 text-xs font-medium text-foreground/80">
            {parsed.phases.length} {parsed.phases.length === 1 ? 'phase' : 'phases'}
            {parsed.agentCalls.length > 0 && (
              <> · {parsed.agentCalls.length} agent {parsed.agentCalls.length === 1 ? 'call site' : 'call sites'}
              {parsed.agentCalls.some((c) => c.inParallel) ? ' (some fan out in parallel)' : ''}</>
            )}
          </p>
          <ol className="space-y-0.5 text-xs text-foreground/70">
            {parsed.phases.map((phase, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-foreground/50">{i + 1}.</span>
                <span>
                  {phase.title}
                  {phase.detail ? <span className="text-foreground/50"> — {phase.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!isWorkflow && prompt && (
        <div className="overflow-hidden rounded-md border border-border bg-white dark:bg-background">
          <pre className="max-h-40 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words p-2 text-xs font-mono text-foreground/75">
            <code>{prompt}</code>
          </pre>
        </div>
      )}
    </div>
  )

  return (
    <RequestItemShell
      title={title}
      subtitle={subtitle}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'capability-review-request-completed' : 'capability-review-request'}
      data-status={isCompleted ? status : undefined}
      completed={
        isCompleted
          ? {
              icon: (
                <Icon
                  className={cn(
                    'h-4 w-4 shrink-0',
                    status === 'approved' ? 'text-green-500' : 'text-red-500'
                  )}
                />
              ),
              label: <>{isWorkflow ? workflowName || 'Workflow' : subagentType || 'Subagent'}</>,
              statusLabel: status === 'approved' ? 'Approved' : 'Blocked',
              isSuccess: status === 'approved',
            }
          : null
      }
      readOnly={
        readOnly
          ? { extraContent: detailBlock }
          : false
      }
    >
      {detailBlock}

      <RequestItemActions>
        <DeclineButton
          onDecline={handleBlock}
          disabled={status === 'submitting'}
          label="Block"
          showIcon={false}
          className="bg-transparent border-border dark:border-white/20 text-foreground hover:bg-muted"
          data-testid="capability-review-block-btn"
        />

        <div className="flex items-stretch">
          <Button
            onClick={() => handleRun('once')}
            loading={status === 'submitting'}
            size="xs"
            className="min-w-20 rounded-r-none border-r-0 bg-orange-600 text-white hover:bg-orange-700"
            data-testid="capability-review-run-btn"
          >
            Run
          </Button>
          <Popover open={runMenuOpen} onOpenChange={setRunMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                disabled={status === 'submitting'}
                size="xs"
                className="rounded-l-none border-l border-l-orange-500 bg-orange-600 px-1.5 text-white hover:bg-orange-700"
                data-testid="capability-review-run-btn-chevron"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1">
              <Button
                onClick={() => {
                  setRunMenuOpen(false)
                  handleRun('session')
                }}
                variant="ghost"
                size="xs"
                className="w-full justify-start text-foreground hover:bg-muted"
                data-testid="capability-review-allow-session-btn"
              >
                Allow for this session
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </RequestItemActions>
    </RequestItemShell>
  )
}
