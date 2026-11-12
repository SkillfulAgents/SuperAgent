import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Monitor, ShieldAlert, ExternalLink } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@renderer/components/ui/dialog'
import { cn } from '@shared/lib/utils/cn'
import { canUseHostFeatures } from '@renderer/lib/capabilities'
import { PERMISSION_LEVEL_LABELS } from '@shared/lib/computer-use/types'
import { SYSTEM_TARGETS } from '@shared/lib/computer-use/commands'
import { RequestItemShell } from '../requests/request-item-shell'
import { RequestItemActions } from '../requests/request-item-actions'
import { ApprovalActions } from '../requests/approval-actions'

/** How the prompt names a target that is not an app. */
const SYSTEM_TARGET_PHRASES: Record<string, string> = {
  [SYSTEM_TARGETS.clipboard]: 'the clipboard',
  [SYSTEM_TARGETS.screen]: 'the entire screen',
  [SYSTEM_TARGETS.notifications]: 'your notifications',
}

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

/** What an approval grants: this call alone, what the call needs, or every app. */
interface Approval {
  grantType: 'once' | 'timed' | 'always'
  /** Grant every app (`use_any_application`) instead of what this call needs. */
  anyApp?: boolean
}

const ANY_APP_HINT = 'any app, the clipboard and the screen, but not shell scripts'

const PERMISSION_LABELS: Record<string, string> = PERMISSION_LEVEL_LABELS

/** An argument as a shell would need it written: quoted when it holds spaces or quotes. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** The command as the user would type it: `agent-desktop click @s1:e5`. */
function formatCommand(method: string, params: Record<string, unknown>): string {
  if (Array.isArray(params.argv)) {
    return ['agent-desktop', method, ...params.argv.map((word) => shellWord(String(word)))].join(' ')
  }
  const parts: string[] = []
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      parts.push(`${key}: ${typeof val === 'string' ? val : JSON.stringify(val)}`)
    }
  }
  return `${method}(${parts.join(', ')})`
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
  const [pendingApproval, setPendingApproval] = useState<Approval | null>(null)
  const commandText = formatCommand(method, params)

  const handleApprove = async (approval: Approval) => {
    const { grantType, anyApp } = approval
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, method, params, permissionLevel, appName, grantType, ...(anyApp && { grantAnyApp: true }) }),
        }
      )

      const data = await response.json().catch(() => ({}))

      if (data.missingPermissions) {
        setMissingPermissions(data.missingPermissions)
        setPendingApproval(approval)
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

  // The permission is needed on the machine that runs the agent, and the deep
  // link opens System Settings on THIS one. Same machine locally; against a
  // cloud workspace it sends you to grant Accessibility on a laptop that is not
  // being automated. The permission list still shows — it is true, and it is
  // what the operator needs to relay — only the button that fixes the wrong
  // computer is withdrawn.
  const canOpenSystemSettings =
    canUseHostFeatures() &&
    (navigator.platform?.startsWith('Mac') || navigator.userAgent?.includes('Mac'))
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
    if (pendingApproval) {
      handleApprove(pendingApproval)
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

  const isCompleted = status === 'executed' || status === 'denied'

  const levelText = PERMISSION_LABELS[permissionLevel]?.toLowerCase() || permissionLevel.replace(/_/g, ' ')
  // Only a use_application grant is limited to one app.
  const appPhrase = appName ? SYSTEM_TARGET_PHRASES[appName] ?? appName : undefined
  const grantScope = permissionLevel === 'use_application' && appPhrase ? `use ${appPhrase}` : levelText
  // The app this call acts in could not be told (a click at a screen point
  // with several windows behind it, say). No grant for one app can cover it,
  // so the card offers this call alone or every app.
  const unplaced = permissionLevel === 'use_application' && !appName
  const descriptionText = appPhrase
    ? `Allow this agent to use ${appPhrase}?`
    : unplaced
      ? 'Allow this agent to act on your computer?'
      : `Allow this agent to ${levelText}?`
  const anyAppOptions = [
    {
      label: 'Any app for 15 min',
      hint: `For 15 minutes this agent can use ${ANY_APP_HINT}, without asking`,
      onSelect: () => handleApprove({ grantType: 'timed', anyApp: true }),
      testId: 'computer-use-any-app-timed-option',
    },
    {
      label: 'Always allow any app',
      hint: `This agent can always use ${ANY_APP_HINT}, without asking`,
      onSelect: () => handleApprove({ grantType: 'always', anyApp: true }),
      testId: 'computer-use-any-app-always-option',
    },
  ]

  const codeBlock = (
    <div className="pt-4">
      <div className="overflow-hidden rounded-card border border-border bg-white dark:bg-background">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all p-2 text-xs font-mono text-foreground/75">
          <code>
            <span className="mr-2 inline-flex h-6 items-center rounded-control bg-muted px-2 text-xs font-medium text-foreground/80 not-italic">
              {PERMISSION_LABELS[permissionLevel] || permissionLevel}
            </span>
            {commandText}
          </code>
        </pre>
      </div>
    </div>
  )

  return (
    <RequestItemShell
      title={descriptionText}
      subtitle={unplaced
        ? 'The app this acts in could not be determined, so it cannot be allowed for one app. Review carefully: this will control your actual computer with your user permissions.'
        : 'Review carefully before allowing. This will control your actual computer with your user permissions.'}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'computer-use-request-completed' : 'computer-use-request'}
      data-status={isCompleted ? status : undefined}
      completed={
        isCompleted
          ? {
              icon: (
                <Monitor
                  className={cn(
                    'h-4 w-4 shrink-0',
                    status === 'executed' ? 'text-green-500' : 'text-red-500'
                  )}
                />
              ),
              label: <>{method}{appName ? ` (${appName})` : ''}</>,
              statusLabel: status === 'executed' ? 'Executed' : 'Denied',
              isSuccess: status === 'executed',
            }
          : null
      }
      readOnly={
        readOnly
          ? { extraContent: codeBlock }
          : false
      }
    >
      {codeBlock}

      <RequestItemActions>
        <ApprovalActions
          testIdPrefix="computer-use"
          disabled={status === 'submitting'}
          onDeny={handleDeny}
          allowLabel={unplaced ? 'Allow Once' : 'Allow 15 min'}
          onAllow={() => handleApprove({ grantType: unplaced ? 'once' : 'timed' })}
          expanded={unplaced
            ? { label: 'Allow Any App', options: anyAppOptions }
            : {
                label: 'Always Allow',
                options: [
                  {
                    label: `Always allow: ${grantScope}`,
                    hint: `This agent can always ${grantScope} without asking`,
                    onSelect: () => handleApprove({ grantType: 'always' }),
                    testId: 'computer-use-always-allow-option',
                  },
                  // The any-app grant never covers a shell script.
                  ...(permissionLevel === 'use_host_shell' ? [] : anyAppOptions),
                ],
              }}
        />
      </RequestItemActions>

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
              <div className="flex items-center justify-between rounded-card border p-3">
                <div>
                  <p className="font-medium text-sm">Accessibility</p>
                  <p className="text-xs text-muted-foreground">Required to interact with UI elements</p>
                </div>
                {canOpenSystemSettings && (
                  <Button size="xs" variant="outline" onClick={() => openSystemSettings('accessibility')}>
                    <ExternalLink className="h-3.5 w-3.5 mr-1" />
                    Open Settings
                  </Button>
                )}
              </div>
            )}
            {missingPermissions && !missingPermissions.screen_recording && (
              <div className="flex items-center justify-between rounded-card border p-3">
                <div>
                  <p className="font-medium text-sm">Screen Recording</p>
                  <p className="text-xs text-muted-foreground">Required to capture screen content</p>
                </div>
                {canOpenSystemSettings && (
                  <Button size="xs" variant="outline" onClick={() => openSystemSettings('screen_recording')}>
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
    </RequestItemShell>
  )
}
