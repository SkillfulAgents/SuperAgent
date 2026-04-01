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
import {
  BLUE_THEME,
  CompletedRequestCard,
  ReadOnlyRequestCard,
  PermissionRequestCard,
} from './permission-request-card'

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

const PERMISSION_LABELS: Record<string, string> = {
  list_apps_windows: 'List Apps & Windows',
  use_application: 'Use Application',
  use_host_shell: 'Host Shell',
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
  const [status, setStatus] = useState<'pending' | 'submitting' | 'executed' | 'denied'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [missingPermissions, setMissingPermissions] = useState<{ accessibility: boolean; screen_recording: boolean } | null>(null)
  const [pendingGrantType, setPendingGrantType] = useState<'once' | 'timed' | 'always' | null>(null)

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

  if (status === 'executed' || status === 'denied') {
    return (
      <CompletedRequestCard
        icon={Monitor}
        method={method}
        scopeLabel={appName}
        status={status}
        testIdPrefix="computer-use"
      />
    )
  }

  if (readOnly) {
    return (
      <ReadOnlyRequestCard
        icon={Monitor}
        title="Computer Use Request"
        method={method}
        scopeLabel={appName}
        theme={BLUE_THEME}
      />
    )
  }

  return (
    <>
      <PermissionRequestCard
        title="Computer Use Request"
        icon={Monitor}
        theme={BLUE_THEME}
        testIdPrefix="computer-use"
        permissionLabel={PERMISSION_LABELS[permissionLevel] || permissionLevel}
        scopeLabel={appName}
        method={method}
        params={params}
        warningText="This will control your computer. Review carefully before approving."
        status={status}
        error={error}
        onApprove={handleApprove}
        onDeny={handleDeny}
      />

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
    </>
  )
}
