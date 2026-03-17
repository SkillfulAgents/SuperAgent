import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Terminal, Check, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from './decline-button'

interface ScriptRunRequestItemProps {
  toolUseId: string
  script: string
  explanation: string
  scriptType: 'applescript' | 'shell' | 'powershell'
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'executed' | 'denied'

const SCRIPT_TYPE_LABELS: Record<string, string> = {
  applescript: 'AppleScript',
  shell: 'Shell',
  powershell: 'PowerShell',
}

export function ScriptRunRequestItem({
  toolUseId,
  script,
  explanation,
  scriptType,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: ScriptRunRequestItemProps) {
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)

  const handleRun = async () => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/run-script`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, script, scriptType }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to execute script')
      }

      setStatus('executed')
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to execute script')
      setStatus('pending')
    }
  }

  const handleDeny = async (reason?: string) => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/run-script`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            decline: true,
            declineReason: reason || 'User denied script execution',
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
      <div className="border rounded-md bg-muted/30 text-sm" data-testid="script-run-request-completed" data-status={status}>
        <div className="flex items-center gap-2 px-3 py-2">
          <Terminal
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'executed' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="text-sm">Script ({SCRIPT_TYPE_LABELS[scriptType] || scriptType})</span>
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
      <div className="border rounded-md bg-orange-50 dark:bg-orange-950/50 border-orange-200 dark:border-orange-800 text-sm">
        <div className="flex items-center gap-3 p-3">
          <div className="h-8 w-8 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center shrink-0">
            <Terminal className="h-4 w-4 text-orange-600 dark:text-orange-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-orange-900 dark:text-orange-100">
              Script Execution Requested
            </div>
            <p className="text-sm text-orange-700 dark:text-orange-300 mt-0.5 whitespace-pre-line">{explanation}</p>
          </div>
          <span className="text-xs text-orange-600 dark:text-orange-400 shrink-0">Waiting for approval</span>
        </div>
      </div>
    )
  }

  // Pending/submitting state
  return (
    <div className="border rounded-md bg-orange-50 dark:bg-orange-950/50 border-orange-200 dark:border-orange-800 text-sm" data-testid="script-run-request">
      <div className="flex items-start gap-3 p-3">
        <div className="h-8 w-8 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center shrink-0">
          <Terminal className="h-4 w-4 text-orange-600 dark:text-orange-400" />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-orange-900 dark:text-orange-100">
                Script Execution Request
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-orange-200 dark:bg-orange-800 text-orange-700 dark:text-orange-300">
                {SCRIPT_TYPE_LABELS[scriptType] || scriptType}
              </span>
            </div>
            <p className="text-sm text-orange-800 dark:text-orange-200 mt-1 whitespace-pre-line">{explanation}</p>
          </div>

          <div className="rounded-md bg-orange-100/50 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-700 overflow-hidden">
            <pre className="p-3 text-xs font-mono text-orange-900 dark:text-orange-100 overflow-x-auto whitespace-pre-wrap break-all">
              <code>{script}</code>
            </pre>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={handleRun}
              disabled={status === 'submitting'}
              size="sm"
              className="bg-orange-600 hover:bg-orange-700 text-white"
              data-testid="script-run-btn"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Run</span>
            </Button>

            <DeclineButton
              onDecline={handleDeny}
              disabled={status === 'submitting'}
              className="border-orange-200 dark:border-orange-700 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-900"
              data-testid="script-deny-btn"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <p className="text-xs text-orange-600 dark:text-orange-400">
            This script will run on your host machine with your user permissions. Review it carefully before approving.
          </p>
        </div>
      </div>
    </div>
  )
}
