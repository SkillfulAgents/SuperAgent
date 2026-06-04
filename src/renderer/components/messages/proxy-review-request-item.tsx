import { apiFetch } from '@renderer/lib/api'
import { useState, useEffect, useRef } from 'react'
import { ShieldCheck, ShieldX, ChevronDown, ChevronRight, ArrowUp } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { cn } from '@shared/lib/utils/cn'
import { getScopeLabel, type ScopeLabel } from '@shared/lib/proxy/scope-metadata'
import { labelDefaultKey } from '@shared/lib/proxy/policy-sentinels'
import ReactMarkdown from 'react-markdown'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'

// read is least privileged, destructive most — used to pick the minimal group
// whose "allow all" still satisfies this request (resolver takes most-permissive).
const LABEL_RANK: Record<ScopeLabel, number> = { read: 0, write: 1, destructive: 2 }

interface ProxyReviewRequestItemProps {
  reviewId: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
  displayText?: string
  sessionId?: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'allowed' | 'denied'

export function ProxyReviewRequestItem({
  reviewId,
  accountId,
  toolkit,
  method,
  targetPath,
  matchedScopes,
  scopeDescriptions,
  displayText,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: ProxyReviewRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const [denyMenuOpen, setDenyMenuOpen] = useState(false)
  const [specificScopeOpen, setSpecificScopeOpen] = useState(false)
  const [denyReason, setDenyReason] = useState('')
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const denyReasonInputRef = useRef<HTMLTextAreaElement | null>(null)
  const requestLabel = `${method} /${targetPath}`

  // The minimal (lowest-risk) label among the matched scopes. Allowing this whole
  // group is the smallest-blast-radius "allow all" that still lets this request
  // through, since the resolver picks the most-permissive sufficient scope.
  const minimalLabel: ScopeLabel | undefined = matchedScopes
    .map((s) => getScopeLabel(toolkit, s))
    .filter((l): l is ScopeLabel => !!l)
    .sort((a, b) => LABEL_RANK[a] - LABEL_RANK[b])[0]
  const isApiReview = !targetPath.startsWith('tools/call')

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

  const handleAlways = async (decision: 'allow' | 'deny', scope: string) => {
    setStatus('submitting')
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/proxy-review/${reviewId}/always`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            scope,
            accountId,
            reviewType: targetPath.startsWith('tools/call') ? 'mcp' : 'api',
          }),
        }
      )
      if (!response.ok) {
        if (response.status === 404) {
          setStatus(decision === 'allow' ? 'allowed' : 'denied')
          completeTimerRef.current = setTimeout(() => onComplete(), 1000)
          return
        }
        const data = await response.json()
        throw new Error(data.error || 'Failed to save policy')
      }
      setStatus(decision === 'allow' ? 'allowed' : 'denied')
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
            <span className="text-xs text-muted-foreground capitalize">{toolkit}</span>
          </>
        ),
        statusLabel: status === 'allowed' ? 'Allowed' : 'Denied',
        isSuccess: status === 'allowed',
      }
    : null

  const readOnlyConfig = readOnly
    ? {
        extraContent: (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-7 items-center rounded-md bg-muted px-2.5 font-mono text-xs text-foreground/85">
                {requestLabel}
              </span>
            </div>
            <p className="mt-2 text-sm leading-5 text-foreground/80 capitalize">Via {toolkit}</p>
          </>
        ),
      }
    : false as const

  return (
    <RequestItemShell
      title={displayText || requestLabel}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'proxy-review-completed' : 'proxy-review-request'}
      data-status={isCompleted ? status : undefined}
    >
      {/* Code block showing method/path + toolkit */}
      <div className="mt-3">
        <div className="rounded-md border border-border bg-white px-3 py-2 dark:bg-background">
          <span className="mr-2 inline-flex h-7 items-center rounded-md bg-muted px-2.5 text-xs font-medium text-foreground/80 capitalize">
            {toolkit}
          </span>
          <span className="font-mono text-xs text-foreground/85">
            {requestLabel}
          </span>
        </div>
      </div>

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
                {matchedScopes.length > 0 && (
                  <div className="w-full py-2">
                    <div className="flex flex-col items-start gap-1">
                      {matchedScopes.map((scope) => (
                        <Button
                          key={scope}
                          data-testid={`proxy-review-always-deny-${scope}`}
                          onClick={() => {
                            setDenyMenuOpen(false)
                            handleAlways('deny', scope)
                          }}
                          disabled={status === 'submitting'}
                          variant="ghost"
                          size="xs"
                          className="h-auto w-full justify-start py-2 text-foreground hover:bg-muted"
                        >
                          <span className="flex flex-col items-start text-left">
                            <span>
                              Always deny{' '}
                              <span className="ml-1 inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/70">
                                {scope}
                              </span>
                            </span>
                            {scopeDescriptions[scope] && (
                              <span className="block w-full truncate text-xs font-normal text-muted-foreground/80 [&_a]:font-normal [&_a]:text-inherit [&_a]:underline">
                                <ReactMarkdown
                                  components={{
                                    p: ({ children }) => <>{children}</>,
                                    a: ({ href, children }) => (
                                      <a href={href} target="_blank" rel="noopener noreferrer">
                                        {children}
                                      </a>
                                    ),
                                  }}
                                >
                                  {scopeDescriptions[scope]}
                                </ReactMarkdown>
                              </span>
                            )}
                          </span>
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="w-full pt-0">
                  {matchedScopes.length > 0 && <div className="mx-3 border-t border-border" />}
                  <div className="w-full px-3 pt-3 pb-0 text-foreground">
                    <span className="flex flex-col items-start text-left">
                      <span className="text-xs font-medium text-foreground">Deny with reason</span>
                      <span className="text-xs font-normal text-muted-foreground/80">
                        Add a note explaining why this action should be denied
                      </span>
                    </span>
                  </div>
                  <div className="mx-3 mt-2 flex min-h-10 gap-2 rounded-md border border-border bg-background pl-3 pr-0 pb-1">
                    <textarea
                      ref={denyReasonInputRef}
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

        <div className="flex items-stretch">
          <Popover
            open={allowMenuOpen}
            onOpenChange={(o) => {
              setAllowMenuOpen(o)
              if (!o) setSpecificScopeOpen(false) // collapse the disclosure on close
            }}
          >
            <PopoverTrigger asChild>
              <Button
                disabled={status === 'submitting'}
                size="xs"
                className="min-w-24 pr-0 bg-orange-600 text-white hover:bg-orange-700"
                data-testid="proxy-review-always-allow-btn"
              >
                <span>Allow</span>
                <ChevronDown className={cn('ml-2 h-3.5 w-3.5 transition-transform', allowMenuOpen && 'rotate-180')} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[380px] max-w-[calc(100vw-2rem)] p-1">
              <div className="flex flex-col items-start gap-0">
                {/* Allow once (this request only) */}
                <Button
                  data-testid="proxy-review-allow-once-menu-btn"
                  onClick={() => {
                    setAllowMenuOpen(false)
                    handleDecision('allow')
                  }}
                  disabled={status === 'submitting'}
                  variant="ghost"
                  size="xs"
                  className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                >
                  <span className="flex min-w-0 w-full flex-col items-start text-left">
                    <span className="block w-full truncate">Allow Once</span>
                    <span className="block w-full truncate text-xs font-normal text-muted-foreground/80">
                      Only allow this action this one time
                    </span>
                  </span>
                </Button>

                {/* Minimal risk group — smallest "allow all" that still covers this request */}
                {isApiReview && minimalLabel && (
                  <>
                    <div className="mx-3 my-1 w-[calc(100%-1.5rem)] border-t border-border" />
                    <Button
                      data-testid={`proxy-review-allow-label-${minimalLabel}`}
                      onClick={() => {
                        setAllowMenuOpen(false)
                        handleAlways('allow', labelDefaultKey(minimalLabel))
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
                        </span>
                        <span className="block w-full truncate text-xs font-normal text-muted-foreground/80">
                          Auto-allow every {minimalLabel}-level scope for this account
                        </span>
                      </span>
                    </Button>
                  </>
                )}

                {/* Per-scope "always allow" — tucked behind a disclosure */}
                {matchedScopes.length > 0 && (
                  <>
                    <div className="mx-3 my-1 w-[calc(100%-1.5rem)] border-t border-border" />
                    <Collapsible
                      open={specificScopeOpen}
                      onOpenChange={setSpecificScopeOpen}
                      className="w-full"
                    >
                      <CollapsibleTrigger
                        data-testid="proxy-review-specific-scope-toggle"
                        className="flex w-full items-center gap-1 rounded-md px-3 py-2 text-left text-xs text-foreground hover:bg-muted"
                      >
                        <ChevronRight
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                            specificScopeOpen && 'rotate-90',
                          )}
                        />
                        <span>Select specific scope for allow all</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        {matchedScopes.map((scope) => (
                          <Button
                            key={scope}
                            data-testid={`proxy-review-always-allow-${scope}`}
                            onClick={() => {
                              setAllowMenuOpen(false)
                              handleAlways('allow', scope)
                            }}
                            disabled={status === 'submitting'}
                            variant="ghost"
                            size="xs"
                            className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                          >
                            <span className="flex min-w-0 w-full flex-col items-start text-left">
                              <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
                                <span className="shrink-0">Always allow</span>
                                <span className="inline-flex min-w-0 max-w-full items-center truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/70">
                                  {scope}
                                </span>
                              </span>
                              {scopeDescriptions[scope] && (
                                <span className="block w-full truncate text-xs font-normal text-muted-foreground/80 [&_a]:font-normal [&_a]:text-inherit [&_a]:underline">
                                  <ReactMarkdown
                                    components={{
                                      p: ({ children }) => <>{children}</>,
                                      a: ({ href, children }) => (
                                        <a href={href} target="_blank" rel="noopener noreferrer">
                                          {children}
                                        </a>
                                      ),
                                    }}
                                  >
                                    {scopeDescriptions[scope]}
                                  </ReactMarkdown>
                                </span>
                              )}
                            </span>
                          </Button>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  </>
                )}

                {/* Allow everything for this account */}
                <div className="mx-3 my-1 w-[calc(100%-1.5rem)] border-t border-border" />
                <Button
                  data-testid="proxy-review-always-allow-all"
                  onClick={() => {
                    setAllowMenuOpen(false)
                    handleAlways('allow', '*')
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
                    </span>
                    <span className="block w-full truncate text-xs font-normal text-muted-foreground/80">
                      Allow full read/edit access to {toolkit}
                    </span>
                  </span>
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </RequestItemActions>
    </RequestItemShell>
  )
}
