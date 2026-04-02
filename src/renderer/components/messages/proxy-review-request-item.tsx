import { apiFetch } from '@renderer/lib/api'
import { useState, useEffect, useRef } from 'react'
import { Loader2, ShieldCheck, ShieldX, ChevronDown, GitPullRequestDraft, ArrowUp } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { RequestTitleChip } from '@renderer/components/messages/request-title-chip'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'
import ReactMarkdown from 'react-markdown'

interface ProxyReviewRequestItemProps {
  reviewId: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
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
    } catch (err: any) {
      setError(err.message || 'Failed to submit decision')
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
          body: JSON.stringify({ decision, scope, accountId }),
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
    } catch (err: any) {
      setError(err.message || 'Failed to save policy')
      setStatus('pending')
    }
  }

  const handleAlwaysAllowApi = async () => {
    setStatus('submitting')
    setError(null)
    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/proxy-review/${reviewId}/always`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'allow', scope: '*', accountId }),
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
    } catch (err: any) {
      setError(err.message || 'Failed to save policy')
      setStatus('pending')
    }
  }

  // Completed state
  if (status === 'allowed' || status === 'denied') {
    return (
      <div
        data-testid="proxy-review-completed"
        data-status={status}
        className="rounded-[12px] border bg-muted/30 px-4 py-3 text-sm shadow-md"
      >
        <div className="flex items-center gap-2">
          {status === 'allowed' ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-green-500" />
          ) : (
            <ShieldX className="h-4 w-4 shrink-0 text-red-500" />
          )}
          <span className="font-medium">
            {requestLabel}
          </span>
          <span className="text-xs text-muted-foreground capitalize">{toolkit}</span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'allowed' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'allowed' ? 'Allowed' : 'Denied'}
          </span>
        </div>
      </div>
    )
  }

  // Read-only state
  if (readOnly) {
    return (
      <div className="rounded-[12px] border bg-muted/30 text-sm shadow-md">
        <div className="p-4">
          <RequestTitleChip className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" icon={<GitPullRequestDraft />}>
            API Request Review
          </RequestTitleChip>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center rounded-md bg-muted px-2.5 font-mono text-xs text-foreground/85">
              {requestLabel}
            </span>
          </div>
          <p className="mt-2 text-sm leading-5 text-foreground/80 capitalize">Via {toolkit}</p>
          <p className="mt-5 text-xs text-muted-foreground">Waiting for approval</p>
        </div>
      </div>
    )
  }

  // Pending state
  return (
    <div
      data-testid="proxy-review-request"
      className="rounded-[12px] border bg-muted/30 text-sm shadow-md"
    >
      <div className="p-4">
        <div className="flex-1 min-w-0">
          <RequestTitleChip className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" icon={<GitPullRequestDraft />}>
            API Request Review
          </RequestTitleChip>

          <div className="mt-5">
            <div className="rounded-md border border-border bg-white px-3 py-2 dark:bg-background">
              <span className="mr-2 inline-flex h-7 items-center rounded-md bg-muted px-2.5 text-xs font-medium text-foreground/80 capitalize">
                {toolkit}
              </span>
              <span className="font-mono text-xs text-foreground/85">
                {requestLabel}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-6">
            <div className="flex items-stretch">
              <Button
                data-testid="proxy-review-deny-btn"
                onClick={() => handleDecision('deny')}
                disabled={status === 'submitting'}
                size="sm"
                variant="outline"
                className="rounded-r-none border-r-0 border-border text-foreground hover:bg-muted"
              >
                Deny
              </Button>
              <Popover open={denyMenuOpen} onOpenChange={setDenyMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    disabled={status === 'submitting'}
                    size="sm"
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
                              size="sm"
                              className="h-auto w-full justify-start py-2 text-foreground hover:bg-muted"
                            >
                              <span className="flex flex-col items-start text-left">
                                <span>
                                  Always deny{' '}
                                  <span className="ml-1 inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/70">
                                    {scope}
                                  </span>
                                </span>
                                {scopeDescriptions[scope] && (
                                  <span className="block w-full truncate text-[11px] font-normal text-muted-foreground/80 [&_a]:font-normal [&_a]:text-inherit [&_a]:underline">
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
                          <span className="text-[11px] font-normal text-muted-foreground/80">
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
              <Popover open={allowMenuOpen} onOpenChange={setAllowMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    disabled={status === 'submitting'}
                    size="sm"
                    className="min-w-24 pr-0 bg-orange-600 text-white hover:bg-orange-700"
                    data-testid="proxy-review-always-allow-btn"
                  >
                    <span>Allow</span>
                    <ChevronDown className={cn('ml-2 h-3.5 w-3.5 transition-transform', allowMenuOpen && 'rotate-180')} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-auto min-w-0 max-w-[480px] p-1">
                  <div className="flex flex-col items-start gap-0">
                    <Button
                      data-testid="proxy-review-allow-once-menu-btn"
                      onClick={() => {
                        setAllowMenuOpen(false)
                        handleDecision('allow')
                      }}
                      disabled={status === 'submitting'}
                      variant="ghost"
                      size="sm"
                      className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                    >
                      <span className="flex min-w-0 w-full flex-col items-start text-left">
                        <span className="block w-full truncate">Allow Once</span>
                        <span className="block w-full truncate text-[11px] font-normal text-muted-foreground/80">
                          Only allow this action this one time
                        </span>
                      </span>
                    </Button>
                    {matchedScopes.length > 0 && (
                      <div className="w-full py-2">
                        <div className="mx-3 border-t border-border" />
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
                            size="sm"
                            className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                          >
                            <span className="flex min-w-0 w-full flex-col items-start text-left">
                              <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
                                <span className="shrink-0">Always allow</span>
                                <span className="inline-flex min-w-0 max-w-full items-center truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/70">
                                  {scope}
                                </span>
                              </span>
                              {scopeDescriptions[scope] && (
                                <span className="block w-full truncate text-[11px] font-normal text-muted-foreground/80 [&_a]:font-normal [&_a]:text-inherit [&_a]:underline">
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
                        <div className="mx-3 border-b border-border" />
                      </div>
                    )}
                  <Button
                    data-testid="proxy-review-always-allow-all"
                    onClick={() => {
                      setAllowMenuOpen(false)
                      handleAlwaysAllowApi()
                    }}
                    disabled={status === 'submitting'}
                    variant="ghost"
                    size="sm"
                    className="h-auto min-w-0 w-full justify-start py-2 text-foreground hover:bg-muted"
                  >
                    <span className="flex min-w-0 w-full flex-col items-start text-left">
                      <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden">
                        <span className="shrink-0">Always allow</span>
                        <span className="inline-flex min-w-0 max-w-full items-center truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/70">
                          all {toolkit} requests
                        </span>
                      </span>
                      <span className="block w-full truncate text-[11px] font-normal text-muted-foreground/80">
                        Allow full read/edit access to {toolkit}
                      </span>
                    </span>
                  </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
              Error: {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
