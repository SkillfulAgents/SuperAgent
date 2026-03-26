import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Monitor, Check, Loader2, Clock, ShieldCheck } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from './decline-button'

interface ComputerUseRequestItemProps {
  toolUseId: string
  method: string
  params: Record<string, unknown>
  permissionLevel: string
  appName?: string
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'executed' | 'denied'

const PERMISSION_LABELS: Record<string, string> = {
  list_apps_windows: 'List Apps & Windows',
  use_application: 'Use Application',
  use_host_shell: 'Host Shell',
}

function formatParams(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      parts.push(`${key}: ${typeof val === 'string' ? val : JSON.stringify(val)}`)
    }
  }
  return parts.join(', ')
}

export function ComputerUseRequestItem({
  toolUseId,
  method,
  params,
  permissionLevel,
  appName,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: ComputerUseRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)

  const handleApprove = async (grantType: 'once' | 'timed' | 'always') => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, method, params, permissionLevel, appName, grantType }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to execute command')
      }

      setStatus('executed')
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to execute command')
      setStatus('pending')
    }
  }

  const handleDeny = async (reason?: string) => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            decline: true,
            declineReason: reason || 'User denied computer use request',
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to deny request')
      }

      setStatus('denied')
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to deny request')
      setStatus('pending')
    }
  }

  // Completed state
  if (status === 'executed' || status === 'denied') {
    return (
      <div className="border rounded-md bg-muted/30 text-sm" data-testid="computer-use-request-completed" data-status={status}>
        <div className="flex items-center gap-2 px-3 py-2">
          <Monitor
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'executed' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="text-sm">{method}{appName ? ` (${appName})` : ''}</span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'executed' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'executed' ? 'Executed' : 'Denied'}
          </span>
        </div>
      </div>
    )
  }

  // Read-only state for viewers
  if (readOnly) {
    return (
      <div className="border rounded-md bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800 text-sm">
        <div className="flex items-center gap-3 p-3">
          <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center shrink-0">
            <Monitor className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-blue-900 dark:text-blue-100">
              Computer Use Request
            </div>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-0.5">
              {method}{appName ? ` — ${appName}` : ''}
            </p>
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for approval</span>
        </div>
      </div>
    )
  }

  const paramStr = formatParams(params)

  // Pending/submitting state
  return (
    <div className="border rounded-md bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800 text-sm" data-testid="computer-use-request">
      <div className="flex items-start gap-3 p-3">
        <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center shrink-0">
          <Monitor className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-blue-900 dark:text-blue-100">
                Computer Use Request
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300">
                {PERMISSION_LABELS[permissionLevel] || permissionLevel}
              </span>
              {appName && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300">
                  {appName}
                </span>
              )}
            </div>
            <p className="text-sm text-blue-800 dark:text-blue-200 mt-1 font-mono">
              {method}{paramStr ? `(${paramStr})` : '()'}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => handleApprove('once')}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className="border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
              data-testid="computer-use-allow-once-btn"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Allow Once</span>
            </Button>

            <Button
              onClick={() => handleApprove('timed')}
              disabled={status === 'submitting'}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="computer-use-allow-timed-btn"
            >
              <Clock className="h-4 w-4" />
              <span className="ml-1">Allow 15 min</span>
            </Button>

            <Button
              onClick={() => handleApprove('always')}
              disabled={status === 'submitting'}
              size="sm"
              variant="outline"
              className="border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
              data-testid="computer-use-allow-always-btn"
            >
              <ShieldCheck className="h-4 w-4" />
              <span className="ml-1">Always Allow</span>
            </Button>

            <DeclineButton
              onDecline={handleDeny}
              disabled={status === 'submitting'}
              className="border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
              data-testid="computer-use-deny-btn"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <p className="text-xs text-blue-600 dark:text-blue-400">
            This will control your computer. Review carefully before approving.
          </p>
        </div>
      </div>
    </div>
  )
}
