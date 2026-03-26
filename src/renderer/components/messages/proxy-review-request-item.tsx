import { apiFetch } from '@renderer/lib/api'
import { useState, useEffect, useRef } from 'react'
import { Check, X, Loader2, Shield, ShieldCheck, ShieldX, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils/cn'

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
  const [showAlwaysOptions, setShowAlwaysOptions] = useState(false)
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (completeTimerRef.current) clearTimeout(completeTimerRef.current)
    }
  }, [])

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
      <div data-testid="proxy-review-completed" data-status={status} className="border rounded-md bg-muted/30 text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          {status === 'allowed' ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-green-500" />
          ) : (
            <ShieldX className="h-4 w-4 shrink-0 text-red-500" />
          )}
          <span className="font-medium">
            {method} /{targetPath}
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
      <div className="border rounded-md bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-sm">
        <div className="flex items-center gap-3 p-3">
          <div className="h-8 w-8 rounded-full bg-amber-100 dark:bg-amber-900 flex items-center justify-center shrink-0">
            <Shield className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-amber-900 dark:text-amber-100">
              Review Required: <span className="font-mono text-xs">{method} /{targetPath}</span>
            </div>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 capitalize">{toolkit}</p>
          </div>
          <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">Waiting for approval</span>
        </div>
      </div>
    )
  }

  // Pending state
  return (
    <div data-testid="proxy-review-request" className="border rounded-md bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-sm">
      <div className="flex items-start gap-3 p-3">
        {/* Icon */}
        <div className="h-8 w-8 rounded-full bg-amber-100 dark:bg-amber-900 flex items-center justify-center shrink-0 mt-0.5">
          <Shield className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-2">
          {/* Header */}
          <div>
            <div className="font-medium text-amber-900 dark:text-amber-100">
              API Request Review
            </div>
            <div className="mt-1 font-mono text-xs bg-amber-100 dark:bg-amber-900/60 px-2 py-1 rounded inline-block">
              {method} /{targetPath}
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1 capitalize">
              via {toolkit}
            </p>
          </div>

          {/* Matched scopes */}
          {matchedScopes.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                Scopes:
              </p>
              <div className="space-y-0.5">
                {matchedScopes.map((scope) => (
                  <div key={scope} className="text-xs">
                    <span className="font-medium text-amber-800 dark:text-amber-200">{scope}</span>
                    {scopeDescriptions[scope] && (
                      <span className="text-amber-600 dark:text-amber-400 ml-1.5">
                        — {scopeDescriptions[scope]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="proxy-review-allow-btn"
              onClick={() => handleDecision('allow')}
              disabled={status === 'submitting'}
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Allow</span>
            </Button>

            <Button
              data-testid="proxy-review-deny-btn"
              onClick={() => handleDecision('deny')}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className="border-red-200 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900"
            >
              <X className="h-4 w-4" />
              <span className="ml-1">Deny</span>
            </Button>

            <Button
              data-testid="proxy-review-remember-btn"
              onClick={() => setShowAlwaysOptions(!showAlwaysOptions)}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className="border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
            >
              <ShieldCheck className="h-4 w-4" />
              <span className="ml-1">Remember</span>
              <ChevronDown className={cn('h-3 w-3 ml-0.5 transition-transform', showAlwaysOptions && 'rotate-180')} />
            </Button>
          </div>

          {/* Always options (expanded) */}
          {showAlwaysOptions && (
            <div className="space-y-1 pl-1 border-l-2 border-amber-200 dark:border-amber-700">
              {matchedScopes.map((scope) => (
                <div key={scope} className="flex items-center gap-1.5">
                  <Button
                    data-testid={`proxy-review-always-allow-${scope}`}
                    onClick={() => handleAlways('allow', scope)}
                    disabled={status === 'submitting'}
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/40 px-1.5"
                  >
                    Always allow <span className="font-mono ml-1">{scope}</span>
                  </Button>
                  <Button
                    data-testid={`proxy-review-always-deny-${scope}`}
                    onClick={() => handleAlways('deny', scope)}
                    disabled={status === 'submitting'}
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 px-1.5"
                  >
                    Always deny
                  </Button>
                </div>
              ))}
              <Button
                data-testid="proxy-review-always-allow-all"
                onClick={handleAlwaysAllowApi}
                disabled={status === 'submitting'}
                size="sm"
                variant="ghost"
                className="h-6 text-xs text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/40 px-1.5"
              >
                Always allow all <span className="capitalize font-medium ml-1">{toolkit}</span> requests
              </Button>
            </div>
          )}

          {/* Error message */}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
