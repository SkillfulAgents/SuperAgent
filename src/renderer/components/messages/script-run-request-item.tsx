import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Terminal, ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from './decline-button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'

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

  const isCompleted = status === 'executed' || status === 'denied'

  return (
    <RequestItemShell
      title="Script Execution Request"
      icon={<Terminal />}
      theme="orange"
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'script-run-request-completed' : 'script-run-request'}
      data-status={isCompleted ? status : undefined}
      completed={
        isCompleted
          ? {
              icon: (
                <Terminal
                  className={cn(
                    'h-4 w-4 shrink-0',
                    status === 'executed' ? 'text-green-500' : 'text-red-500'
                  )}
                />
              ),
              label: `Script (${SCRIPT_TYPE_LABELS[scriptType] || scriptType})`,
              statusLabel: status === 'executed' ? 'Executed' : 'Denied',
              isSuccess: status === 'executed',
            }
          : null
      }
      readOnly={
        readOnly
          ? {
              extraContent: (
                <div className="mt-8 flex flex-wrap items-center gap-2">
                  <span className="inline-flex h-7 items-center rounded-md bg-muted px-2.5 text-xs font-medium text-foreground/80">
                    {SCRIPT_TYPE_LABELS[scriptType] || scriptType}
                  </span>
                </div>
              ),
              description: (
                <p className="mt-4 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{explanation}</p>
              ),
            }
          : false
      }
    >
      <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{explanation}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Review carefully before allowing. This script will run on your actual computer with your user permissions.
      </p>

      <div className="pt-4">
        <div className="overflow-hidden rounded-md border border-border bg-white dark:bg-background">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 text-xs font-mono text-foreground/75">
            <code>
              <span className="mr-2 inline-flex h-6 items-center rounded-md bg-muted px-2 text-xs font-medium text-foreground/80 not-italic">
                {SCRIPT_TYPE_LABELS[scriptType] || scriptType}
              </span>
              {script}
            </code>
          </pre>
        </div>
      </div>

      <RequestItemActions>
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
            loading={status === 'submitting'}
            size="sm"
            className="min-w-28 rounded-r-none border-r-0 bg-orange-600 text-white hover:bg-orange-700"
            data-testid="script-run-once-btn"
          >
            Allow Once
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
                data-testid="script-run-timed-btn"
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
      </RequestItemActions>
    </RequestItemShell>
  )
}
