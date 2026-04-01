import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useAgents } from '@renderer/hooks/use-agents'
import { Button } from '@renderer/components/ui/button'
import { Globe, Trash2 } from 'lucide-react'
import type { BrowserUseSettings } from '@shared/lib/browser-use/types'

const PERMISSION_LABELS: Record<string, string> = {
  browse_read: 'Read Page',
  browse_interact: 'Interact with Page',
  browse_navigate: 'Navigate',
  browse_manage: 'Browser Control',
}

export function BrowserUsePermissionsSection() {
  const { data: settings } = useSettings()
  const { data: agents } = useAgents()
  const updateSettings = useUpdateSettings()

  const browserUse = settings?.browserUse as BrowserUseSettings | undefined
  const agentPermissions = browserUse?.agentPermissions || {}
  const hasGrants = Object.keys(agentPermissions).length > 0

  const agentNameMap = new Map(agents?.map((a) => [a.slug, a.name]) ?? [])

  const handleRevokeAll = (agentSlug: string) => {
    const newPerms = { ...agentPermissions }
    delete newPerms[agentSlug]
    updateSettings.mutate({
      browserUse: { agentPermissions: newPerms },
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
      browserUse: { agentPermissions: newPerms },
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium flex items-center gap-2">
          <Globe className="h-4 w-4" />
          Browser Permissions
        </h4>
        <p className="text-sm text-muted-foreground mt-1">
          Agents request permission before using the browser. Permissions are granted per-agent and can be scoped to specific domains.
        </p>
      </div>

      <div>
        <h4 className="text-sm font-medium mb-2">Permission Levels</h4>
        <ul className="text-sm text-muted-foreground space-y-1">
          <li><strong>Read Page</strong> — Observe page content: snapshot, screenshot, get state.</li>
          <li><strong>Interact with Page</strong> — Click, fill, scroll, press, select, hover on a page.</li>
          <li><strong>Navigate</strong> — Open/navigate to a URL.</li>
          <li><strong>Browser Control</strong> — Close browser, run arbitrary commands.</li>
        </ul>
      </div>

      <div>
        <h4 className="text-sm font-medium mb-2">Persistent Permissions (&quot;Always Allow&quot;)</h4>
        {!hasGrants ? (
          <p className="text-sm text-muted-foreground">
            No persistent permissions granted. Permissions will be requested when agents need browser access.
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
                        {grant.domain ? ` — ${grant.domain}` : ' — any domain'}
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
