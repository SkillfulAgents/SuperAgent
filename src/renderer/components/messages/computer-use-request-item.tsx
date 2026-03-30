import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Monitor, Check, Loader2, Clock, ShieldCheck, ShieldAlert, ExternalLink } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@renderer/components/ui/dialog'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { RequestTitleChip } from './request-title-chip'
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
  const [missingPermissions, setMissingPermissions] = useState<{ accessibility: boolean; screen_recording: boolean } | null>(null)
  const [pendingGrantType, setPendingGrantType] = useState<'once' | 'timed' | 'always' | null>(null)
  const [allowMenuOpen, setAllowMenuOpen] = useState(false)
  const paramStr = formatParams(params)

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

      const data = await response.json().catch(() => ({}))

      if (data.missingPermissions) {
        setMissingPermissions(data.missingPermissions)
        setPendingGrantType(grantType)
        setStatus('pending')
        return
      }

      if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`)
      }

      setStatus('executed')
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to execute command')
      setStatus('pending')
    }
  }

  const isMac = navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac')

  const openSystemSettings = (pane: 'accessibility' | 'screen_recording') => {
    if (isMac) {
      const url = pane === 'accessibility'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      window.electronAPI?.openExternal(url)
    }
  }

  const retryAfterPermissions = () => {
    setMissingPermissions(null)
    if (pendingGrantType) {
      handleApprove(pendingGrantType)
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="computer-use-request-completed" data-status={status}>
        <div className="flex items-center gap-2 p-4">
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<Monitor />}>
              Computer Use Request
            </RequestTitleChip>
            <p className="mt-8 whitespace-pre-line text-sm font-medium leading-5 text-foreground">
              {appName
                ? `Allow the agent to use ${appName}?`
                : `Allow the agent to ${PERMISSION_LABELS[permissionLevel]?.toLowerCase() || permissionLevel.replace(/_/g, ' ')}?`}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Review carefully before allowing. This will control your actual computer with your user permissions.
            </p>
            <div className="pt-4">
              <div className="overflow-hidden rounded-md border border-border bg-white dark:bg-background">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 text-xs font-mono text-foreground/75">
                  <code>
                    <span className="mr-2 inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] font-medium text-foreground/80 not-italic">
                      {PERMISSION_LABELS[permissionLevel] || permissionLevel}
                    </span>
                    {method}{paramStr ? `(${paramStr})` : '()'}
                  </code>
                </pre>
              </div>
            </div>
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for approval</span>
        </div>
      </div>
    )
  }

  // Pending/submitting state
  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" data-testid="computer-use-request">
      <div className="p-4">
        <div className="flex-1 min-w-0">
          <div>
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<Monitor />}>
              Computer Use Request
            </RequestTitleChip>
            <p className="mt-8 whitespace-pre-line text-sm font-medium leading-5 text-foreground">
              {appName
                ? `Allow the agent to use ${appName}?`
                : `Allow the agent to ${PERMISSION_LABELS[permissionLevel]?.toLowerCase() || permissionLevel.replace(/_/g, ' ')}?`}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Review carefully before allowing. This will control your actual computer with your user permissions.
            </p>
          </div>

          <div className="pt-4">
            <div className="overflow-hidden rounded-md border border-border bg-white dark:bg-background">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 text-xs font-mono text-foreground/75">
                <code>
                  <span className="mr-2 inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] font-medium text-foreground/80 not-italic">
                    {PERMISSION_LABELS[permissionLevel] || permissionLevel}
                  </span>
                  {method}{paramStr ? `(${paramStr})` : '()'}
                </code>
              </pre>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-8">
            <DeclineButton
              onDecline={handleDeny}
              disabled={status === 'submitting'}
              className="border-border text-foreground hover:bg-muted"
              data-testid="computer-use-deny-btn"
            />

            <div className="flex items-stretch">
              <Button
                onClick={() => handleApprove('timed')}
                disabled={status === 'submitting'}
                size="sm"
                className="min-w-28 rounded-r-none border-r-0 bg-blue-600 text-white hover:bg-blue-700"
                data-testid="computer-use-allow-timed-btn"
              >
                {status === 'submitting' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span>Allow 15 min</span>
                )}
                {status === 'submitting' ? <span className="ml-1">Allow 15 min</span> : null}
              </Button>
              <Popover open={allowMenuOpen} onOpenChange={setAllowMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    disabled={status === 'submitting'}
                    size="sm"
                    className="rounded-l-none border-l border-l-blue-500 bg-blue-600 px-1.5 text-white hover:bg-blue-700"
                    data-testid="computer-use-allow-timed-btn-chevron"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-1">
                  <Button
                    onClick={() => {
                      setAllowMenuOpen(false)
                      handleApprove('once')
                    }}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-foreground hover:bg-muted"
                    data-testid="computer-use-allow-once-btn"
                  >
                    Allow Once
                  </Button>
                  <Button
                    onClick={() => {
                      setAllowMenuOpen(false)
                      handleApprove('always')
                    }}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-foreground hover:bg-muted"
                    data-testid="computer-use-allow-always-btn"
                  >
                    Always Allow
                  </Button>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {error && (
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
              Error: {error}
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!missingPermissions} onOpenChange={(open) => { if (!open) setMissingPermissions(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              System Permissions Required
            </DialogTitle>
            <DialogDescription>
              Computer Use needs system permissions to interact with your desktop.
              {isMac ? ' Please enable the following in System Settings:' : ' Please check your system settings:'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            {missingPermissions && !missingPermissions.accessibility && (
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="font-medium text-sm">Accessibility</p>
                  <p className="text-xs text-muted-foreground">Required to interact with UI elements</p>
                </div>
                {isMac && (
                  <Button size="sm" variant="outline" onClick={() => openSystemSettings('accessibility')}>
                    <ExternalLink className="h-3.5 w-3.5 mr-1" />
                    Open Settings
                  </Button>
                )}
              </div>
            )}
            {missingPermissions && !missingPermissions.screen_recording && (
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="font-medium text-sm">Screen Recording</p>
                  <p className="text-xs text-muted-foreground">Required to capture screen content</p>
                </div>
                {isMac && (
                  <Button size="sm" variant="outline" onClick={() => openSystemSettings('screen_recording')}>
                    <ExternalLink className="h-3.5 w-3.5 mr-1" />
                    Open Settings
                  </Button>
                )}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            After enabling permissions, you may need to restart the app for changes to take effect.
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMissingPermissions(null)}>
              Cancel
            </Button>
            <Button onClick={retryAfterPermissions}>
              Retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
