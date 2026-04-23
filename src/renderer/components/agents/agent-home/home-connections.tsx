import { useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { MoreVertical, Plus, Settings, Settings2, Trash2 } from 'lucide-react'
import { useSelection } from '@renderer/context/selection-context'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useAgentConnectedAccounts, useRemoveAgentConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import { useAgentRemoteMcps, useRemoveMcpFromAgent } from '@renderer/hooks/use-remote-mcps'
import { HomeCollapsible } from './home-collapsible'
import { HomeRow } from './home-row'
import { formatDistanceToNow } from 'date-fns'

type SettingsTab = 'connected-accounts' | 'remote-mcps'

interface HomeConnectionsProps {
  agentSlug: string
  onOpenSettings?: (tab?: SettingsTab) => void
}

interface ConnectionRow {
  id: string
  rawId: string
  name: string
  subtitle?: string
  iconSlug?: string
  type: 'oauth' | 'mcp'
  date: string | number
  settingsTab: SettingsTab
}

// MCP's `mappedAt` can be a numeric-string epoch in ms, not an ISO date.
// Accounts store `createdAt` as a real ISO string, so the numeric branch
// only protects the MCP case.
function safeDate(value: string | number): Date {
  if (typeof value === 'number') return new Date(value)
  const num = Number(value)
  return Number.isFinite(num) ? new Date(num) : new Date(value)
}

export function HomeConnections({ agentSlug, onOpenSettings }: HomeConnectionsProps) {
  const { data: accountsData } = useAgentConnectedAccounts(agentSlug)
  const { data: mcpsData } = useAgentRemoteMcps(agentSlug)
  const { selectConnections } = useSelection()

  const connections = useMemo<ConnectionRow[]>(() => {
    const rows: ConnectionRow[] = []

    if (accountsData?.accounts) {
      for (const account of accountsData.accounts) {
        rows.push({
          id: `account-${account.id}`,
          rawId: account.id,
          name: account.provider?.displayName ?? account.toolkitSlug,
          subtitle: account.displayName,
          iconSlug: account.toolkitSlug,
          type: 'oauth',
          date: account.createdAt,
          settingsTab: 'connected-accounts',
        })
      }
    }

    if (mcpsData?.mcps) {
      for (const mcp of mcpsData.mcps) {
        rows.push({
          id: `mcp-${mcp.id}`,
          rawId: mcp.id,
          name: mcp.name,
          subtitle: mcp.url,
          iconSlug: undefined,
          type: 'mcp',
          date: mcp.mappedAt,
          settingsTab: 'remote-mcps',
        })
      }
    }

    rows.sort((a, b) => safeDate(b.date).getTime() - safeDate(a.date).getTime())

    return rows
  }, [accountsData, mcpsData])

  return (
    <HomeCollapsible title="Connections">
      {connections.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {connections.map((conn) => (
            <ConnectionRowItem
              key={conn.id}
              conn={conn}
              agentSlug={agentSlug}
              onConfigure={() => onOpenSettings?.(conn.settingsTab)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No connections yet</p>
          <p className="text-xs mt-1">
            Connect APIs or MCP servers to give your agent access to external services like Gmail or Slack.
          </p>
        </div>
      )}
      <div className="flex items-center justify-between mt-3 px-4 pb-1">
        {connections.length === 0 && (
          <div className="flex items-center" aria-hidden="true">
            {['atlassian', 'slack', 'notion', 'github', 'linear', 'figma', 'gmail'].map((slug, i) => (
              <div
                key={slug}
                className="h-8 w-8 rounded-lg border border-border bg-background flex items-center justify-center shadow-sm transition-transform duration-100 ease-out hover:scale-110 hover:z-10"
                style={{ marginLeft: i === 0 ? 0 : -8, zIndex: i }}
              >
                <img
                  src={`${import.meta.env.BASE_URL}service-icons/${slug}.svg`}
                  alt=""
                  className="h-4 w-4 object-contain"
                />
              </div>
            ))}
            <div
              className="h-8 w-8 rounded-lg border border-border bg-background flex items-center justify-center shadow-sm transition-transform duration-100 ease-out hover:scale-110 hover:z-10"
              style={{ marginLeft: -8, zIndex: 8 }}
            >
              <span className="text-2xs font-medium text-muted-foreground/70">70+</span>
            </div>
          </div>
        )}
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => selectConnections(true)}
            data-testid="home-connections-open-page"
          >
            {connections.length > 0 ? <Settings2 /> : <Plus />}
            {connections.length > 0 ? 'Manage Connections' : 'Add Connection'}
          </Button>
        </div>
      </div>
    </HomeCollapsible>
  )
}

function ConnectionRowItem({
  conn,
  agentSlug,
  onConfigure,
}: {
  conn: ConnectionRow
  agentSlug: string
  onConfigure: () => void
}) {
  const removeAccount = useRemoveAgentConnectedAccount()
  const removeMcp = useRemoveMcpFromAgent()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const isRemoving = removeAccount.isPending || removeMcp.isPending

  const handleRemove = async () => {
    setRemoveError(null)
    try {
      if (conn.type === 'oauth') {
        await removeAccount.mutateAsync({ agentSlug, accountId: conn.rawId })
      } else {
        await removeMcp.mutateAsync({ agentSlug, mcpId: conn.rawId })
      }
      setShowDeleteDialog(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove connection'
      setRemoveError(message)
    }
  }

  return (
    <>
      <HomeRow
        onActivate={onConfigure}
        actions={
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label={`Actions for ${conn.name}`}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1">
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onConfigure()
                }}
              >
                <Settings className="h-3.5 w-3.5" />
                Configure
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteDialog(true)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            </PopoverContent>
          </Popover>
        }
      >
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
            <ServiceIcon
              slug={conn.iconSlug}
              fallback="blocks"
              className="h-4 w-4 text-muted-foreground/60"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{conn.name}</div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mt-0.5">
              <span className="flex min-w-0 items-center gap-1">
                <span className="shrink-0">{conn.type}</span>
                {conn.subtitle && (
                  <>
                    <span className="shrink-0">·</span>
                    <span className="truncate">{conn.subtitle}</span>
                  </>
                )}
              </span>
              <span className="whitespace-nowrap shrink-0">
                {formatDistanceToNow(safeDate(conn.date), { addSuffix: true })}
              </span>
            </div>
          </div>
        </div>
      </HomeRow>

      <AlertDialog
        open={showDeleteDialog}
        onOpenChange={(open) => {
          setShowDeleteDialog(open)
          if (!open) setRemoveError(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Connection</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove &quot;{conn.name}&quot; from this agent? The connection itself will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && (
            <p className="text-xs text-destructive" role="alert">{removeError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleRemove()
              }}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
