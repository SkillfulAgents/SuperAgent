import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useAgents } from '@renderer/hooks/use-agents'
import { getPlatform } from '@renderer/lib/env'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Monitor, AlertTriangle, Trash2 } from 'lucide-react'
import type { ComputerUseSettings } from '@shared/lib/computer-use/types'

const PERMISSION_LABELS: Record<string, string> = {
  list_apps_windows: 'List Apps & Windows',
  use_application: 'Use Application',
  use_host_shell: 'Host Shell',
}

export function ComputerUseTab() {
  const { data: settings } = useSettings()
  const { data: agents } = useAgents()
  const updateSettings = useUpdateSettings()
  const platform = getPlatform()
  const supported = platform === 'darwin' || platform === 'win32'

  if (!supported) {
    return (
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Not Available</AlertTitle>
        <AlertDescription>
          Computer Use is only available on macOS and Windows in the Electron desktop app.
        </AlertDescription>
      </Alert>
    )
  }

  const computerUse = settings?.computerUse as ComputerUseSettings | undefined
  const agentPermissions = computerUse?.agentPermissions || {}
  const hasGrants = Object.keys(agentPermissions).length > 0

  // Map slug → display name
  const agentNameMap = new Map(agents?.map((a) => [a.slug, a.name]) ?? [])

  const handleRevokeAll = (agentSlug: string) => {
    const newPerms = { ...agentPermissions }
    delete newPerms[agentSlug]
    updateSettings.mutate({
      computerUse: { agentPermissions: newPerms },
    })
  }

  const handleRevokeGrant = (agentSlug: string, grantIndex: number) => {
    const agentGrants = agentPermissions[agentSlug]?.grants || []
    const newGrants = agentGrants.filter((_, i) => i !== grantIndex)
    const newPerms = { ...agentPermissions }
    if (newGrants.length === 0) {
      delete newPerms[agentSlug]
    } else {
      newPerms[agentSlug] = { grants: newGrants }
    }
    updateSettings.mutate({
      computerUse: { agentPermissions: newPerms },
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium flex items-center gap-2">
          <Monitor className="h-5 w-5" />
          Computer Use
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Agents can control applications on your computer. Permissions are granted per-agent when requested.
        </p>
      </div>

      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Security Warning</AlertTitle>
        <AlertDescription>
          Computer Use allows agents to interact with applications on your machine using your user permissions.
          Review each request carefully. Only grant persistent permissions to trusted agents.
        </AlertDescription>
      </Alert>

      <div>
        <h4 className="text-sm font-medium mb-3">Permission Levels</h4>
        <ul className="text-sm text-muted-foreground space-y-1.5">
          <li><strong>List Apps & Windows</strong> — Read-only: list running applications and open windows.</li>
          <li><strong>Use Application</strong> — Interact with a specific app: click, type, screenshot, etc.</li>
          <li><strong>Host Shell</strong> — Run shell commands and scripts on the host machine.</li>
        </ul>
      </div>

      <div>
        <h4 className="text-sm font-medium mb-3">Persistent Permissions (&quot;Always Allow&quot;)</h4>
        {!hasGrants ? (
          <p className="text-sm text-muted-foreground">
            No persistent permissions granted. Permissions will be granted per-request when agents need computer access.
          </p>
        ) : (
          <div className="space-y-3">
            {Object.entries(agentPermissions).map(([agentSlug, agentPerms]) => (
              <div key={agentSlug} className="border rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-sm">{agentNameMap.get(agentSlug) || agentSlug}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevokeAll(agentSlug)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Revoke All
                  </Button>
                </div>
                <div className="space-y-1">
                  {agentPerms.grants.map((grant, i) => (
                    <div key={i} className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>
                        {PERMISSION_LABELS[grant.level] || grant.level}
                        {grant.appName ? ` — ${grant.appName}` : ''}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRevokeGrant(agentSlug, i)}
                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
