import { useState, useEffect, useCallback } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Download, RefreshCw, CheckCircle2, Loader2 } from 'lucide-react'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  progress?: number
  error?: string
}

export function UpdateSection() {
  const { data: userSettings } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { track } = useAnalyticsTracking()
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    window.electronAPI?.getUpdateStatus().then(setStatus)
    window.electronAPI?.onUpdateStatus(setStatus)
    return () => {
      window.electronAPI?.removeUpdateStatus()
    }
  }, [])

  const handleCheck = useCallback(async () => {
    track('updates_checked')
    await window.electronAPI?.checkForUpdates()
  }, [track])

  const handleDownload = useCallback(async () => {
    await window.electronAPI?.downloadUpdate()
  }, [])

  const handleInstall = useCallback(() => {
    window.electronAPI?.installUpdate()
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>Software Updates</Label>
          <p className="text-xs text-muted-foreground">
            {status.state === 'idle' && 'Check for available updates'}
            {status.state === 'checking' && 'Checking for updates...'}
            {status.state === 'not-available' && 'You are on the latest version'}
            {status.state === 'available' && `Version ${status.version} is available`}
            {status.state === 'downloading' && <span>Downloading... <span className="tabular-nums">{Math.round(status.progress ?? 0)}%</span></span>}
            {status.state === 'downloaded' && `Version ${status.version} is ready to install`}
            {status.state === 'error' && `Update error: ${status.error}`}
          </p>
        </div>
        <div>
          {(status.state === 'idle' || status.state === 'not-available' || status.state === 'error') && (
            <Button variant="outline" size="sm" onClick={handleCheck}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Check for Updates
            </Button>
          )}
          {status.state === 'checking' && (
            <Button variant="outline" size="sm" disabled>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Checking...
            </Button>
          )}
          {status.state === 'available' && (
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="h-4 w-4 mr-2" />
              Download
            </Button>
          )}
          {status.state === 'downloading' && (
            <Button variant="outline" size="sm" disabled>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              <span className="tabular-nums">{Math.round(status.progress ?? 0)}%</span>
            </Button>
          )}
          {status.state === 'downloaded' && (
            <Button size="sm" onClick={handleInstall}>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Restart & Update
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="prerelease-updates">Include pre-release versions</Label>
          <p className="text-xs text-muted-foreground">
            Get early access to release candidates and beta versions
          </p>
        </div>
        <Switch
          id="prerelease-updates"
          checked={!!userSettings?.allowPrereleaseUpdates}
          onCheckedChange={(checked: boolean) => {
            updateUserSettings.mutate({ allowPrereleaseUpdates: checked })
          }}
        />
      </div>
    </div>
  )
}
