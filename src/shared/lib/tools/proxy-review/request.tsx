import { apiFetch } from '@renderer/lib/api'
import { useState, useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { ShieldCheck, ShieldX, ChevronDown, ChevronRight, ArrowUp, Settings, Info } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { cn } from '@shared/lib/utils/cn'
import { getScopeLabel, type ScopeLabel } from '@shared/lib/proxy/scope-metadata'
import type { ProxyReviewType } from '@shared/lib/proxy/review-display'
import { labelDefaultKey } from '@shared/lib/proxy/policy-sentinels'
import type { Components } from 'react-markdown'
import { Markdown } from '@renderer/components/ui/markdown'
import { useAgentConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useAgentRemoteMcps } from '@renderer/hooks/use-remote-mcps'
import {
  isForeignAgentConnectedAccount,
  isForeignAgentRemoteMcp,
  type AgentConnectedAccountDto,
  type AgentRemoteMcpDto,
} from '@shared/lib/agent-connections/public'
import { RequestItemShell } from '../requests/request-item-shell'
import { RequestItemActions } from '../requests/request-item-actions'
import { heldByRequireRule, type ReviewRuleOutcomeView, type RuleProposalReview } from '@shared/lib/proxy/rules/proposal-schema'
import { RuleOutcomesList, RuleProposalRequestItem } from './rule-review'

// Endpoint descriptions come from API docs and carry inline Markdown
// (`code`, [links](…)). The title renders them inline: no paragraph or block
// wrappers inside a one-line heading.
const Inline = ({ children }: { children?: React.ReactNode }) => <>{children}</>
const TITLE_MARKDOWN: Components = {
  p: Inline,
  pre: Inline,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">{children}</code>,
}

// read is least privileged, destructive most — used to pick the minimal group
// whose "allow all" still satisfies this request (resolver takes most-permissive).
const LABEL_RANK: Record<ScopeLabel, number> = { read: 0, write: 1, destructive: 2 }

// The connections-page detail key for the reviewed account or MCP server, or null
// when this viewer can't open it: another member's connection (foreign DTOs carry
// no id) or one no longer on the agent.
function ownedConnectionDetailKey(
  reviewType: ProxyReviewType,
  id: string,
  accounts: AgentConnectedAccountDto[] | undefined,
  mcps: AgentRemoteMcpDto[] | undefined,
): string | null {
  if (reviewType === 'mcp') {
    return mcps?.some((m) => !isForeignAgentRemoteMcp(m) && m.id === id) ? `mcp-${id}` : null
  }
  return accounts?.some((a) => !isForeignAgentConnectedAccount(a) && a.id === id) ? `account-${id}` : null
}

interface ProxyReviewRequestItemProps {
  reviewId: string
  accountId: string
  /**
   * Stamped by the proxy that raised the review. When absent (envelopes from
   * before the stamp) the `tools/call` path prefix is the only hint left.
   */
  reviewType?: ProxyReviewType
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  displayText?: string
  /** The specific call, when the lookup could name it. Without it the headline is general, so the body opens. */
  endpointDescription?: string
  /** What the request sends, as text. */
  requestBody?: string
  /** Proxy rules that ran on the request and did not allow it. */
  ruleOutcomes?: ReviewRuleOutcomeView[]
  /** Present when the review asks to approve an agent's proxy rule. */
  ruleProposal?: RuleProposalReview
  sessionId?: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'allowed' | 'denied'

const HINT_ICON = <Info aria-hidden className="!size-3 shrink-0 text-muted-foreground/40" />

/** Shows a menu option's explanation when the option is hovered or focused. */
function InfoHint({ text, children }: { text: string; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-[240px] text-xs font-normal">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The service, method and path, and what the request sends. The body starts open when the card
 * cannot name the call: it is then the only thing that says what the call does.
 */
function RequestDetails({ toolkit, requestLabel, requestBody, named }: {
  toolkit: ReactNode
  requestLabel: string
  requestBody?: string
  named: boolean
}) {
  return (
    <Collapsible defaultOpen={!named} className="mt-3 rounded-md border border-border bg-white px-3 py-2 dark:bg-background">
      <div className="flex items-center">
        <span className="mr-2 inline-flex h-7 shrink-0 items-center rounded-md bg-muted px-2.5 text-xs font-medium text-foreground/80 capitalize">
          {toolkit}
        </span>
        <span className="min-w-0 flex-1 break-all font-mono text-xs text-foreground/85">{requestLabel}</span>
        {requestBody && (
          <CollapsibleTrigger
            data-testid="proxy-review-body-toggle"
            aria-label="Show what the request sends"
            className="group ml-2 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
          </CollapsibleTrigger>
        )}
      </div>
      {requestBody && (
        <CollapsibleContent>
          <pre data-testid="proxy-review-body" className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground/75">
            {requestBody}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

export function ProxyReviewRequestItem(props: ProxyReviewRequestItemProps) {
  if (props.ruleProposal) {
    return (
      <RuleProposalRequestItem
        reviewId={props.reviewId}
        agentSlug={props.agentSlug}
        displayText={props.displayText}
        proposal={props.ruleProposal}
        sessionId={props.sessionId}
        readOnly={props.readOnly}
        onComplete={props.onComplete}
      />
    )
  }
  return <ScopeReviewRequestItem {...props} />
}

function ScopeReviewRequestItem({
  reviewId,
  accountId,
  reviewType,
  toolkit,
  method,
  targetPath,
  matchedScopes,
  displayText,
  endpointDescription,
  requestBody,
  ruleOutcomes,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: ProxyReviewRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const [denyMenuOpen, setDenyMenuOpen] = useState(false)
  const [denyReason, setDenyReason] = useState('')
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const denyReasonInputRef = useRef<HTMLTextAreaElement | null>(null)
  const requestLabel = `${method} /${targetPath}`
  const named = !!endpointDescription

  // The minimal (lowest-risk) label among the matched scopes. Allowing this whole
  // group is the smallest-blast-radius "allow all" that still lets this request
  // through, since the resolver picks the most-permissive sufficient scope.
  const minimalLabel: ScopeLabel | undefined = matchedScopes
    .map((s) => getScopeLabel(toolkit, s))
    .filter((l): l is ScopeLabel => !!l)
    .sort((a, b) => LABEL_RANK[a] - LABEL_RANK[b])[0]
  // Never infer from the path when the review says what it is: an MCP call
  // whose JSON-RPC method is not `tools/call` has a bare method path, and
  // treating it as an API review sent the MCP server id to the API-scope
  // policy table (FOREIGN KEY failure on "always allow").
  const resolvedReviewType: ProxyReviewType =
    reviewType ?? (targetPath.startsWith('tools/call') ? 'mcp' : 'api')
  const isApiReview = resolvedReviewType === 'api'
  // A require rule held this request: changing the policy wouldn't stop the
  // rule holding the next one, so only one-off decisions are offered.
  const heldByRule = heldByRequireRule(ruleOutcomes)

  const navigate = useNavigate()
  const router = useRouter()
  const { data: accountsData } = useAgentConnectedAccounts(agentSlug)
  const { data: mcpsData } = useAgentRemoteMcps(agentSlug)
  const connectionDetailKey = ownedConnectionDetailKey(
    resolvedReviewType,
    accountId,
    accountsData?.accounts,
    mcpsData?.mcps,
  )
  // `source: 'home'` is required with `detail`; `from` overrides where Back goes.
  const openConnection = connectionDetailKey
    ? () => {
        void navigate({
          to: '/agents/$slug/connections',
          params: { slug: agentSlug },
          search: {
            detail: connectionDetailKey,
            source: 'home',
            from: router.state.location.pathname + router.state.location.searchStr,
          },
        })
      }
    : null
  // The toolkit name opens its connection page wherever the card shows it.
  const toolkitName = (className?: string) =>
    openConnection ? (
      <button
        type="button"
        data-testid="proxy-review-connection-link"
        onClick={openConnection}
        className={cn(className, 'capitalize hover:underline')}
      >
        {toolkit}
      </button>
    ) : (
      <span className={className}>{toolkit}</span>
    )

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current)
    }
  }, [])

  const handleDecision = async (decision: 'allow' | 'deny', reason?: string) => {
    setStatus('submitting')
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/proxy-review/${reviewId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, reason }),
        }
      )
      if (!response.ok) {
        // 404 means already resolved (e.g., by "Always Allow" on another review) — dismiss gracefully
        if (response.status === 404) {
          setStatus(decision === 'allow' ? 'allowed' : 'denied')
          completeTimerRef.current = setTimeout(() => onComplete(), 1000)
          return
        }
        const data = await response.json()
        throw new Error(data.error || 'Failed to submit decision')
      }
      setStatus(decision === 'allow' ? 'allowed' : 'denied')
      completeTimerRef.current = setTimeout(() => onComplete(), 2000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit decision')
      setStatus('pending')
    }
  }

  const handleAlways = async (scope: string) => {
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
            accountId,
            reviewType: resolvedReviewType,
          }),
        }
      )
      if (!response.ok) {
        if (response.status === 404) {
          setStatus('allowed')
          completeTimerRef.current = setTimeout(() => onComplete(), 1000)
          return
        }
        const data = await response.json()
        throw new Error(data.error || 'Failed to save policy')
      }
      setStatus('allowed')
      completeTimerRef.current = setTimeout(() => onComplete(), 2000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save policy')
      setStatus('pending')
    }
  }


  const isCompleted = status === 'allowed' || status === 'denied'

  const completedConfig = isCompleted
    ? {
        icon: status === 'allowed'
          ? <ShieldCheck className="h-4 w-4 shrink-0 text-green-500" />
          : <ShieldX className="h-4 w-4 shrink-0 text-red-500" />,
        label: (
          <>
            <span className="font-medium">{requestLabel}</span>{' '}
            {toolkitName('text-xs text-muted-foreground capitalize')}
          </>
        ),
        statusLabel: status === 'allowed' ? 'Allowed' : 'Denied',
        isSuccess: status === 'allowed',
      }
    : null

  const readOnlyConfig = readOnly
    ? {
        extraContent: (
          <RequestDetails toolkit={toolkitName()} requestLabel={requestLabel} requestBody={requestBody} named={named} />
        ),
      }
    : false as const

  return (
    <RequestItemShell
      title={displayText ? <Markdown components={TITLE_MARKDOWN}>{displayText}</Markdown> : requestLabel}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'proxy-review-completed' : 'proxy-review-request'}
      data-review-id={reviewId}
      data-status={isCompleted ? status : undefined}
    >
      {/* Code block showing method/path + toolkit, what the request sends, and the rules that held it */}
      <RequestDetails toolkit={toolkitName()} requestLabel={requestLabel} requestBody={requestBody} named={named} />
      {ruleOutcomes && ruleOutcomes.length > 0 && <RuleOutcomesList outcomes={ruleOutcomes} />}

      {/* Action buttons */}
      <RequestItemActions>
        <div className="flex items-stretch">
          <Button
            data-testid="proxy-review-deny-btn"
            onClick={() => handleDecision('deny')}
            disabled={status === 'submitting'}
            size="xs"
            variant="outline"
            className="rounded-r-none border-r-0 border-border text-foreground hover:bg-muted"
          >
            Deny
          </Button>
          <Popover open={denyMenuOpen} onOpenChange={setDenyMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                disabled={status === 'submitting'}
                size="xs"
                variant="outline"
                className="rounded-l-none border-border px-1.5 text-foreground hover:bg-muted"
                data-testid="proxy-review-deny-btn-chevron"
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', denyMenuOpen && 'rotate-180')} />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-auto min-w-0 max-w-[480px] px-1 pt-1 pb-4"
              onOpenAutoFocus={(e) => {
                e.preventDefault()
                requestAnimationFrame(() => {
                  denyReasonInputRef.current?.focus()
                })
              }}
              onCloseAutoFocus={() => setDenyReason('')}
            >
              <div className="flex flex-col items-start gap-0">
                <div className="w-full pt-0">
                  <InfoHint text="Add a note explaining why this action should be denied">
                    <div className="flex w-full items-center gap-1 px-3 pt-2 pb-0 text-xs font-medium text-foreground">
                      <span>Deny with reason</span>
                      {HINT_ICON}
                    </div>
                  </InfoHint>
                  <div className="mx-3 mt-2 flex min-h-10 gap-2 rounded-md border border-border bg-background pl-3 pr-0 pb-1">
                    <textarea
                      ref={denyReasonInputRef}
                      data-testid="proxy-review-deny-reason-input"
                      placeholder="Reason for denying..."
                      value={denyReason}
                      rows={1}
                      onChange={(e) => {
                        setDenyReason(e.target.value)
                        e.currentTarget.style.height = 'auto'
                        e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`
                      }}
                      className="flex-1 self-center resize-none overflow-hidden bg-transparent px-0 pr-1 py-2 text-xs placeholder:text-xs placeholder:text-muted-foreground/80 focus:outline-none focus:ring-0"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && denyReason.trim()) {
                          e.preventDefault()
                          setDenyMenuOpen(false)
                          handleDecision('deny', denyReason.trim())
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="icon"
                      data-testid="proxy-review-deny-reason-submit"
                      disabled={!denyReason.trim() || status === 'submitting'}
                      onClick={() => {
                        setDenyMenuOpen(false)
                        handleDecision('deny', denyReason.trim())
                      }}
                      className="mr-1 h-8 w-8 shrink-0 self-end rounded-md border border-border bg-foreground text-background hover:bg-foreground/90"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <Button
          data-testid="proxy-review-allow-once-btn"
          onClick={() => handleDecision('allow')}
          disabled={status === 'submitting'}
          size="xs"
          variant={heldByRule ? 'default' : 'outline'}
          className={heldByRule ? 'bg-orange-600 text-white hover:bg-orange-700' : 'border-border text-foreground hover:bg-muted'}
        >
          Allow Once
        </Button>

        {!heldByRule && (
        <div className="flex items-stretch">
          <Popover
            open={allowMenuOpen}
            onOpenChange={setAllowMenuOpen}
          >
            <PopoverTrigger asChild>
              <Button
                disabled={status === 'submitting'}
                size="xs"
                className="min-w-24 pr-2 bg-orange-600 text-white hover:bg-orange-700"
                data-testid="proxy-review-always-allow-btn"
              >
                <span>Always Allow</span>
                <ChevronDown className={cn('ml-1.5 h-3.5 w-3.5 transition-transform', allowMenuOpen && 'rotate-180')} />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-auto max-w-[min(380px,calc(100vw-2rem))] p-1"
              // Focusing the first option would open its hint on every open.
              onOpenAutoFocus={(e) => {
                e.preventDefault()
                if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
              }}
            >
              <div className="flex flex-col items-start gap-0">
                {/* Minimal risk group — smallest "allow all" that still covers this request.
                    An unnamed API call's scopes union every action on its path, so allowing
                    any of them can allow a delete: those cards skip it. */}
                {isApiReview && named && minimalLabel && (
                  <InfoHint text={`Auto-allow every ${minimalLabel}-level scope for this account`}>
                  <Button
                    data-testid={`proxy-review-allow-label-${minimalLabel}`}
                    onClick={() => {
                      setAllowMenuOpen(false)
                      handleAlways(labelDefaultKey(minimalLabel))
                    }}
                    disabled={status === 'submitting'}
                    variant="ghost"
                    size="xs"
                    className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                  >
                    <span className="flex min-w-0 w-full flex-col items-start text-left">
                      <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
                        <span className="shrink-0">Allow all</span>
                        <span className="inline-flex shrink-0 items-center rounded-md bg-muted px-1.5 py-0.5 text-xs capitalize text-foreground/70">
                          {minimalLabel}
                        </span>
                        <span className="shrink-0">
                          requests to <span className="capitalize">{toolkit}</span>
                        </span>
                        {HINT_ICON}
                      </span>
                    </span>
                  </Button>
                  </InfoHint>
                )}

                {/* Allow everything for this account */}
                <InfoHint text={`Allow full read/edit access to ${toolkit}`}>
                  <Button
                    data-testid="proxy-review-always-allow-all"
                    onClick={() => {
                      setAllowMenuOpen(false)
                      handleAlways('*')
                    }}
                    disabled={status === 'submitting'}
                    variant="ghost"
                    size="xs"
                    className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                  >
                    <span className="flex min-w-0 w-full flex-col items-start text-left">
                      <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
                        <span className="shrink-0">
                          Always allow all <span className="capitalize">{toolkit}</span> requests
                        </span>
                        {HINT_ICON}
                      </span>
                    </span>
                  </Button>
                </InfoHint>

                {openConnection && (
                  <Button
                    data-testid="proxy-review-edit-permissions"
                    onClick={() => {
                      setAllowMenuOpen(false)
                      openConnection()
                    }}
                    variant="ghost"
                    size="xs"
                    className="h-auto min-w-0 w-full justify-start gap-1.5 py-2 text-xs font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Settings className="!size-3" />
                    <span>Advanced permission settings</span>
                    <ChevronRight className="!size-3" />
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        )}
      </RequestItemActions>
    </RequestItemShell>
  )
}
