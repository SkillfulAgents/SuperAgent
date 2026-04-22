import { apiFetch } from '@renderer/lib/api'
import { useState, useEffect, useRef } from 'react'
import { ShieldCheck, ShieldX, ChevronDown, Users, ArrowRight, MessageSquare } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'
import { useSelection } from '@renderer/context/selection-context'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'

interface XAgentReviewRequestItemProps {
  reviewId: string
  agentSlug: string // caller agent (the one who needs approval)
  xAgent: {
    targetAgentSlug: string
    targetAgentName: string
    operation: 'list' | 'read' | 'invoke' | 'create'
    preview?: string
  }
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'allowed' | 'denied'

function operationLabel(op: 'list' | 'read' | 'invoke' | 'create'): string {
  switch (op) {
    case 'list': return 'list agents'
    case 'read': return 'read sessions'
    case 'invoke': return 'send a message'
    case 'create': return 'create an agent'
  }
}

function operationVerb(op: 'list' | 'read' | 'invoke' | 'create'): string {
  switch (op) {
    case 'list': return 'list other agents in this workspace'
    case 'read': return 'read sessions'
    case 'invoke': return 'send a message'
    case 'create': return 'create a new agent'
  }
}

export function XAgentReviewRequestItem({
  reviewId,
  agentSlug,
  xAgent,
  readOnly,
  onComplete,
}: XAgentReviewRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)
  const { selectAgent } = useSelection()

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current)
    }
  }, [])

  const targetIsActionable = xAgent.operation === 'invoke' || xAgent.operation === 'read'
  const isCreate = xAgent.operation === 'create'
  // For 'create' there is no policy table entry — only Allow Once is offered
  const canRemember = !isCreate

  // Apply a terminal status + schedule onComplete, but only if the component is
  // still mounted. Avoids React's "setState on unmounted component" warning when
  // the user scrolls/navigates away mid-fetch.
  const finishWith = (next: 'allowed' | 'denied', delayMs: number) => {
    if (!isMountedRef.current) return
    setStatus(next)
    completeTimerRef.current = setTimeout(() => onComplete(), delayMs)
  }

  const handleDecision = async (decision: 'allow' | 'deny') => {
    setStatus('submitting')
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/proxy-review/${reviewId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      )
      if (!response.ok && response.status !== 404) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to submit decision')
      }
      // 404 = review already gone (timed out / resolved by another tab).
      // Treat as success so the user sees their click took effect locally.
      finishWith(decision === 'allow' ? 'allowed' : 'denied', response.ok ? 1500 : 1000)
    } catch (err: unknown) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to submit decision')
      setStatus('pending')
    }
  }

  const handleAlways = async (operation: 'list' | 'read' | 'invoke') => {
    // 'list' → null target; 'read'/'invoke' → target slug
    const targetSlug = operation === 'list' ? null : xAgent.targetAgentSlug
    const scope = operation === 'list' ? 'list' : `${operation}:${xAgent.targetAgentSlug}`

    setStatus('submitting')
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/proxy-review/${reviewId}/always`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'allow',
            scope,
            // accountId is unused by the /always handler when reviewType='xagent'
            // (target lives in xAgent.targetSlug below) — pass it as null for 'list'
            // so server-side audit logs don't get a meaningless empty string.
            accountId: targetSlug,
            reviewType: 'xagent',
            xAgent: { operation, targetSlug },
          }),
        },
      )
      if (!response.ok && response.status !== 404) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to save policy')
      }
      finishWith('allowed', response.ok ? 1500 : 1000)
    } catch (err: unknown) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to save policy')
      setStatus('pending')
    }
  }

  const isCompleted = status === 'allowed' || status === 'denied'
  const targetButton = targetIsActionable ? (
    <button
      type="button"
      onClick={() => selectAgent(xAgent.targetAgentSlug)}
      className="font-medium text-foreground hover:underline"
    >
      {xAgent.targetAgentName}
    </button>
  ) : (
    <span className="font-medium text-foreground">{xAgent.targetAgentName}</span>
  )

  const completedConfig = isCompleted
    ? {
        icon: status === 'allowed'
          ? <ShieldCheck className="h-4 w-4 shrink-0 text-green-500" />
          : <ShieldX className="h-4 w-4 shrink-0 text-red-500" />,
        label: (
          <>
            <span className="font-medium capitalize">{operationLabel(xAgent.operation)}</span>
            {targetIsActionable && (
              <>
                {' '}
                <span className="text-xs text-muted-foreground">→ {xAgent.targetAgentName}</span>
              </>
            )}
          </>
        ),
        statusLabel: status === 'allowed' ? 'Allowed' : 'Denied',
        isSuccess: status === 'allowed',
      }
    : null

  const readOnlyConfig = readOnly
    ? {
        description: (
          <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Wants to {operationVerb(xAgent.operation)}</span>
            {targetIsActionable && (
              <>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                {targetButton}
              </>
            )}
          </div>
        ),
      }
    : false as const

  return (
    <RequestItemShell
      title="Agent Action"
      icon={<Users />}
      theme="orange"
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'xagent-review-completed' : 'xagent-review-request'}
      data-status={isCompleted ? status : undefined}
    >
      {/* What's being asked */}
      <p className="mt-6 text-sm leading-5 text-foreground">
        Allow this agent to <span className="font-medium">{operationVerb(xAgent.operation)}</span>
        {targetIsActionable && (
          <>
            {' '}to{' '}{targetButton}
          </>
        )}
        {isCreate && (
          <>
            {' '}named{' '}
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{xAgent.targetAgentName}</span>
          </>
        )}
        ?
      </p>

      {/* Prompt preview for invoke */}
      {xAgent.operation === 'invoke' && xAgent.preview && (
        <div className="mt-3 rounded-md border border-border bg-background px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquare className="h-3 w-3" />
            <span>Message preview</span>
          </div>
          <p className="text-sm text-foreground/85 line-clamp-3 whitespace-pre-wrap">{xAgent.preview}</p>
        </div>
      )}

      {/* Action buttons */}
      <RequestItemActions className="pt-6">
        <Button
          data-testid="xagent-review-deny-btn"
          onClick={() => handleDecision('deny')}
          disabled={status === 'submitting'}
          size="sm"
          variant="outline"
          className="border-border text-foreground hover:bg-muted"
        >
          Deny
        </Button>

        <div className="flex items-stretch">
          <Button
            data-testid="xagent-review-allow-once-btn"
            onClick={() => handleDecision('allow')}
            disabled={status === 'submitting'}
            size="sm"
            className={cn(
              canRemember ? 'rounded-r-none border-r border-r-orange-700' : '',
              'bg-orange-600 text-white hover:bg-orange-700',
            )}
          >
            Allow{canRemember ? ' Once' : ''}
          </Button>
          {canRemember && (
            <Popover open={allowMenuOpen} onOpenChange={setAllowMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  disabled={status === 'submitting'}
                  size="sm"
                  className="rounded-l-none bg-orange-600 px-1.5 text-white hover:bg-orange-700"
                  data-testid="xagent-review-allow-menu"
                >
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', allowMenuOpen && 'rotate-180')} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto min-w-[260px] p-1">
                <div className="flex flex-col items-stretch">
                  {xAgent.operation === 'list' && (
                    <Button
                      data-testid="xagent-review-always-list"
                      onClick={() => { setAllowMenuOpen(false); handleAlways('list') }}
                      disabled={status === 'submitting'}
                      variant="ghost"
                      size="sm"
                      className="h-auto justify-start py-2 text-foreground hover:bg-muted"
                    >
                      <span className="flex flex-col items-start text-left">
                        <span>Always allow listing agents</span>
                        <span className="text-xs font-normal text-muted-foreground/80">
                          Skip this prompt for future <code className="font-mono">list_agents</code> calls
                        </span>
                      </span>
                    </Button>
                  )}
                  {xAgent.operation === 'read' && (
                    <Button
                      data-testid="xagent-review-always-read"
                      onClick={() => { setAllowMenuOpen(false); handleAlways('read') }}
                      disabled={status === 'submitting'}
                      variant="ghost"
                      size="sm"
                      className="h-auto justify-start py-2 text-foreground hover:bg-muted"
                    >
                      <span className="flex flex-col items-start text-left">
                        <span>Always allow reading <span className="font-medium">{xAgent.targetAgentName}</span></span>
                        <span className="text-xs font-normal text-muted-foreground/80">
                          Lets this agent read sessions and transcripts (no message-sending)
                        </span>
                      </span>
                    </Button>
                  )}
                  {xAgent.operation === 'invoke' && (
                    <>
                      <Button
                        data-testid="xagent-review-always-invoke"
                        onClick={() => { setAllowMenuOpen(false); handleAlways('invoke') }}
                        disabled={status === 'submitting'}
                        variant="ghost"
                        size="sm"
                        className="h-auto justify-start py-2 text-foreground hover:bg-muted"
                      >
                        <span className="flex flex-col items-start text-left">
                          <span>Always allow messaging <span className="font-medium">{xAgent.targetAgentName}</span></span>
                          <span className="text-xs font-normal text-muted-foreground/80">
                            Send-only — sync responses are returned, but browsing history still prompts
                          </span>
                        </span>
                      </Button>
                      <Button
                        data-testid="xagent-review-always-read-only"
                        onClick={() => { setAllowMenuOpen(false); handleAlways('read') }}
                        disabled={status === 'submitting'}
                        variant="ghost"
                        size="sm"
                        className="h-auto justify-start py-2 text-foreground hover:bg-muted"
                      >
                        <span className="flex flex-col items-start text-left">
                          <span>Always allow reading <span className="font-medium">{xAgent.targetAgentName}</span> (this time only)</span>
                          <span className="text-xs font-normal text-muted-foreground/80">
                            View-only access to history; future <code className="font-mono">invoke</code> calls still prompt
                          </span>
                        </span>
                      </Button>
                    </>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </RequestItemActions>
    </RequestItemShell>
  )
}
