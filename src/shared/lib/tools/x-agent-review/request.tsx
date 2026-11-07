import { xAgentReviewAttachments, type XAgentReview } from '@shared/lib/proxy/x-agent-review'
import { apiFetch } from '@renderer/lib/api'
import { useState, useEffect, useRef } from 'react'
import { ShieldCheck, ShieldX, MessageSquare, Paperclip } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { RequestItemShell } from '../requests/request-item-shell'
import { RequestItemActions } from '../requests/request-item-actions'
import { ApprovalActions, type ExpandedGrant } from '../requests/approval-actions'

interface XAgentReviewRequestItemProps {
  reviewId: string
  sessionId?: string
  agentSlug: string // caller agent (the one who needs approval)
  xAgent: XAgentReview
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
  sessionId,
  agentSlug,
  xAgent,
  readOnly,
  onComplete,
}: XAgentReviewRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endBlockedRef = useRef<(() => void) | null>(null)
  const isMountedRef = useRef(true)
  const navigate = useNavigate()

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current)
      endBlockedRef.current?.()
    }
  }, [])

  const targetIsActionable = xAgent.operation === 'invoke' || xAgent.operation === 'read'
  const isCreate = xAgent.operation === 'create'
  const isFileDownload = xAgent.fileTransfer?.kind === 'download'
  const attachments = xAgentReviewAttachments(xAgent)
  const hasAttachments = attachments.length > 0

  // Apply a terminal status + schedule onComplete, but only if the component is
  // still mounted. Avoids React's "setState on unmounted component" warning when
  // the user scrolls/navigates away mid-fetch.
  const finishWith = (next: 'allowed' | 'denied', delayMs: number) => {
    if (!isMountedRef.current) return
    setStatus(next)
    completeTimerRef.current = setTimeout(() => onComplete(), delayMs)
  }

  const postDecision = (decision: 'allow' | 'deny', reason?: string) =>
    apiFetch(`/api/agents/${agentSlug}/proxy-review/${reviewId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, reason }),
    })

  const handleDecision = async (decision: 'allow' | 'deny', reason?: string) => {
    setStatus('submitting')
    setError(null)
    try {
      const response = await postDecision(decision, reason)
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

  const handleAlways = async (
    operation: 'list' | 'read' | 'invoke',
    scopeChoice: 'this' | 'all' = 'this',
  ) => {
    // 'list' has no target. For 'read'/'invoke', scopeChoice='all' applies the
    // policy globally (target=null), 'this' applies to xAgent.targetAgentSlug only.
    const targetSlug =
      operation === 'list' || scopeChoice === 'all' ? null : xAgent.targetAgentSlug
    const scope =
      operation === 'list'
        ? 'list'
        : scopeChoice === 'all'
          ? `${operation}:*`
          : `${operation}:${xAgent.targetAgentSlug}`

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
            // and for "all agents" so server-side audit logs don't get a meaningless empty string.
            accountId: targetSlug,
            reviewType: 'xagent',
            xAgent: { operation, targetSlug },
          }),
        },
      )
      if (!response.ok && response.status !== 404) {
        const data = await response.json()
        // An Owner blocked this link while the card was open: say so here, then end the request
        // with Allow Once, which the Block refuses. Leaving the card before then ends it too.
        if (data.blocked) {
          if (!isMountedRef.current) {
            void postDecision('allow')
            return
          }
          endBlockedRef.current = () => {
            endBlockedRef.current = null
            void postDecision('allow')
          }
          setBlocked(true)
          setStatus('denied')
          completeTimerRef.current = setTimeout(() => {
            endBlockedRef.current?.()
            onComplete()
          }, 2000)
          return
        }
        throw new Error(data.error || 'Failed to save policy')
      }
      finishWith('allowed', response.ok ? 1500 : 1000)
    } catch (err: unknown) {
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to save policy')
      setStatus('pending')
    }
  }

  const targetChip = (
    <span className="inline-flex items-center rounded-item bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/70">{xAgent.targetAgentName}</span>
  )
  const expanded: ExpandedGrant | undefined =
    xAgent.operation === 'list' ? { label: 'Always Allow', hint: 'This agent can see your other agents and their descriptions without asking', onSelect: () => handleAlways('list') }
    : xAgent.operation === 'read' ? { label: 'Always Allow', options: [
      { label: <>Always allow reading {targetChip}</>, hint: `This agent can read ${xAgent.targetAgentName}'s sessions and delivered files without asking`, onSelect: () => handleAlways('read', 'this'), testId: 'xagent-review-always-read' },
      { label: <>Always allow reading <span className="font-medium">all agents</span></>, hint: "This agent can read every agent's sessions and delivered files without asking", onSelect: () => handleAlways('read', 'all'), testId: 'xagent-review-always-read-all' },
    ] } : xAgent.operation === 'invoke' ? { label: 'Always Allow', options: [
      { label: <>Always allow messaging {targetChip}</>, hint: `This agent can message ${xAgent.targetAgentName}, with attachments, without asking. Reading ${xAgent.targetAgentName}'s sessions still asks.`, onSelect: () => handleAlways('invoke', 'this'), testId: 'xagent-review-always-invoke' },
      { label: <>Always allow messaging <span className="font-medium">all agents</span></>, hint: 'This agent can message every agent, with attachments, without asking', onSelect: () => handleAlways('invoke', 'all'), testId: 'xagent-review-always-invoke-all' },
      { label: <>Allow this message and always allow reading {targetChip}</>, hint: `Sends this message now. This agent can read ${xAgent.targetAgentName}'s sessions and delivered files without asking. Future messages still ask.`, onSelect: () => handleAlways('read', 'this'), testId: 'xagent-review-always-read-only' },
    ] } : undefined

  const isCompleted = status === 'allowed' || status === 'denied'
  const targetButton = targetIsActionable ? (
    <button
      type="button"
      onClick={() => {
        void navigate({ to: '/agents/$slug', params: { slug: xAgent.targetAgentSlug } })
      }}
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
        statusLabel: status === 'allowed' ? 'Allowed' : blocked ? 'Blocked by policy' : 'Denied',
        isSuccess: status === 'allowed',
      }
    : null

  const titleNode = (
    <>
      Allow this agent to <span className="font-medium">{isFileDownload ? 'download a delivered file' : operationVerb(xAgent.operation)}</span>
      {hasAttachments && <span className="font-medium"> and share {attachments.length} {attachments.length === 1 ? 'file' : 'files'}</span>}
      {targetIsActionable && (
        <>
          {' '}{xAgent.operation === 'read' ? 'from' : 'to'}{' '}{targetButton}
        </>
      )}
      {isCreate && (
        <>
          {' '}named{' '}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{xAgent.targetAgentName}</span>
        </>
      )}
      ?
    </>
  )

  const invokeDetails = xAgent.operation === 'invoke' ? (
    <>
      {xAgent.preview && (
        <div className="mt-3 rounded-card border border-border bg-background px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MessageSquare className="h-3 w-3" />
            <span>Message preview</span>
          </div>
          <p className="text-sm text-foreground/85 line-clamp-3 whitespace-pre-wrap">{xAgent.preview}</p>
        </div>
      )}
      {!!attachments?.length && (
        <div className="mt-3 rounded-card border border-border bg-background px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Paperclip className="h-3 w-3" />
            <span>{attachments.length} {attachments.length === 1 ? 'file' : 'files'} to share</span>
          </div>
          <ul className="space-y-1">
            {attachments.map((filePath, index) => (
              <li
                key={`${filePath}-${index}`}
                className="truncate font-mono text-xs text-foreground/85"
                title={filePath}
              >
                {filePath}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  ) : null
  const downloadDetails = xAgent.fileTransfer?.kind === 'download' ? (
    <div className="mt-3 rounded-item border border-border bg-background px-3 py-2 text-xs text-foreground/85">
      {xAgent.fileTransfer.filename}
    </div>
  ) : null
  const readOnlyConfig = readOnly ? { extraContent: <>{invokeDetails}{downloadDetails}</> } : false as const

  return (
    <RequestItemShell
      title={titleNode}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'xagent-review-completed' : 'xagent-review-request'}
      data-review-id={reviewId}
      data-status={isCompleted ? status : undefined}
    >
      {invokeDetails}

      {downloadDetails}

      <RequestItemActions>
        <ApprovalActions
          testIdPrefix="xagent-review"
          disabled={status === 'submitting'}
          onDeny={(reason) => handleDecision('deny', reason)}
          onAllow={() => handleDecision('allow')}
          allowLabel={expanded ? 'Allow Once' : 'Allow'}
          expanded={expanded}
        />
      </RequestItemActions>
    </RequestItemShell>
  )
}
