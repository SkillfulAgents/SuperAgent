import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useAgents } from '@renderer/hooks/use-agents'
import { getPlatform } from '@renderer/lib/env'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { TriangleAlert } from 'lucide-react'
import { PERMISSION_LEVEL_LABELS, type ComputerUseSettings } from '@shared/lib/computer-use/types'

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

export function ComputerUseTab() {
  const { data: settings } = useSettings()
  const { data: agents } = useAgents()
  const updateSettings = useUpdateSettings()
  const platform = getPlatform()
  const supported = platform === 'darwin' || platform === 'win32'

  if (!supported) {
    return (
      <Alert>
        <TriangleAlert className="h-4 w-4" />
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
  const displayName = (agentSlug: string) => agentNameMap.get(agentSlug) ?? agentSlug

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
      <div className="flex gap-2 rounded-md bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-500/90 leading-relaxed">
        <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <p>
          Agents interact with applications on your machine using your user permissions.
          Review each request carefully and only grant persistent access to trusted agents.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Persistent Permissions</h3>
        {!hasGrants ? (
          <div className={CARD_CLASS}>
            <p className="py-3 px-4 text-[11px] text-muted-foreground leading-relaxed">
              Agents you grant `always allow` computer use permissions will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(agentPermissions).map(([agentSlug, agentPerms]) => (
              <div key={agentSlug} className={CARD_CLASS}>
                <div className="group flex items-center justify-between py-2 pl-4 pr-2">
                  <span className="text-xs font-medium truncate">{displayName(agentSlug)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevokeAll(agentSlug)}
                    className="h-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                  >
                    Revoke All
                  </Button>
                </div>
                {agentPerms.grants.map((grant, i) => (
                  <div key={i} className="group flex items-center justify-between py-2 pl-4 pr-2">
                    <span className="text-[11px] text-muted-foreground truncate">
                      {PERMISSION_LEVEL_LABELS[grant.level] || grant.level}
                      {grant.appName ? ` — ${grant.appName}` : ''}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevokeGrant(agentSlug, i)}
                      className="h-6 px-2 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
