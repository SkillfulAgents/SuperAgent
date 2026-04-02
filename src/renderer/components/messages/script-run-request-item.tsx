import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Terminal, Check, Loader2, Clock, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { RequestTitleChip } from './request-title-chip'
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
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)

  const handleApprove = async (grantType: 'once' | 'timed' | 'always') => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/run-script`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, script, scriptType, grantType }),
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="script-run-request-completed" data-status={status}>
        <div className="flex items-center gap-2 p-4">
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" icon={<Terminal />}>
              Script Execution Request
            </RequestTitleChip>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <span className="inline-flex h-7 items-center rounded-md bg-muted px-2.5 text-xs font-medium text-foreground/80">
                {SCRIPT_TYPE_LABELS[scriptType] || scriptType}
              </span>
            </div>
            <p className="mt-4 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{explanation}</p>
          </div>
          <span className="text-xs text-orange-600 dark:text-orange-400 shrink-0">Waiting for approval</span>
        </div>
      </div>
    )
  }

  // Pending/submitting state
  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="script-run-request">
      <div className="p-4">
        <div className="flex-1 min-w-0">
          <div>
            <RequestTitleChip className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" icon={<Terminal />}>
              Script Execution Request
            </RequestTitleChip>
            <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{explanation}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Review carefully before allowing. This script will run on your actual computer with your user permissions.
            </p>
          </div>

          <div className="pt-4">
            <div className="overflow-hidden rounded-md border border-border bg-white dark:bg-background">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 text-xs font-mono text-foreground/75">
                <code>
                  <span className="mr-2 inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] font-medium text-foreground/80 not-italic">
                    {SCRIPT_TYPE_LABELS[scriptType] || scriptType}
                  </span>
                  {script}
                </code>
              </pre>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-8">
            <DeclineButton
              onDecline={handleDeny}
              disabled={status === 'submitting'}
              label="Deny"
              showIcon={false}
              className="border-border text-foreground hover:bg-muted"
              data-testid="script-deny-btn"
            />

            <div className="flex items-stretch">
              <Button
                onClick={() => handleApprove('once')}
                disabled={status === 'submitting'}
                size="sm"
                className="min-w-28 rounded-r-none border-r-0 bg-orange-600 text-white hover:bg-orange-700"
                data-testid="script-run-timed-btn"
              >
                {status === 'submitting' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span>Allow Once</span>
                )}
                {status === 'submitting' ? <span>Allow Once</span> : null}
              </Button>
              <Popover open={allowMenuOpen} onOpenChange={setAllowMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    disabled={status === 'submitting'}
                    size="sm"
                    className="rounded-l-none border-l border-l-orange-500 bg-orange-600 px-1.5 text-white hover:bg-orange-700"
                    data-testid="script-run-timed-btn-chevron"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-1">
                  <Button
                    onClick={() => {
                      setAllowMenuOpen(false)
                      handleApprove('timed')
                    }}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-foreground hover:bg-muted"
                    data-testid="script-run-once-btn"
                  >
                    Allow 15 min
                  </Button>
                  <Button
                    onClick={() => {
                      setAllowMenuOpen(false)
                      handleApprove('always')
                    }}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-foreground hover:bg-muted"
                    data-testid="script-run-always-btn"
                  >
                    Always Allow
                  </Button>
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
