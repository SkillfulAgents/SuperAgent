import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { AlertTriangle } from 'lucide-react'

export function HostShellUseTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  const platform = getPlatform()
  const supported = isElectron() && (platform === 'darwin' || platform === 'win32')

  if (!supported) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            Host shell execution is only available on macOS and Windows in the Electron desktop app.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const allowScriptExecution = settings?.hostShellUse?.allowScriptExecution ?? false

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="allow-script-execution">Allow Script Execution</Label>
          <p className="text-xs text-muted-foreground">
            Allow agents to request running scripts on the host machine.
            Each execution still requires your explicit approval.
          </p>
        </div>
        <Switch
          id="allow-script-execution"
          checked={allowScriptExecution}
          onCheckedChange={(checked) => {
            updateSettings.mutate({ hostShellUse: { allowScriptExecution: checked } })
          }}
          disabled={isLoading}
        />
      </div>

      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          Scripts run directly on your host machine with your user permissions.
          Always review the script content carefully before clicking &quot;Run&quot;.
          Only enable this if you trust the agents you are running.
        </AlertDescription>
      </Alert>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>Supported script types on {platform === 'darwin' ? 'macOS' : 'Windows'}:</p>
        <ul className="list-disc list-inside pl-2">
          {platform === 'darwin' && (
            <>
              <li>AppleScript (via osascript)</li>
              <li>Shell (via /bin/zsh)</li>
            </>
          )}
          {platform === 'win32' && (
            <li>PowerShell</li>
          )}
        </ul>
      </div>
    </div>
  )
}
