import { useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ChevronRight, MoreVertical, Plus, Settings, Trash2 } from 'lucide-react'
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
import { formatDistanceToNow } from 'date-fns'

interface HomeConnectionsProps {
  agentSlug: string
  onOpenSettings?: (tab?: string) => void
}

interface ConnectionRow {
  id: string
  rawId: string
  name: string
  subtitle?: string
  iconSlug: string
  type: 'oauth' | 'mcp'
  date: string | number
  settingsTab: string
}

/** Parse a date value that may be an ISO string, numeric string, or number (ms epoch). */
function safeDate(value: string | number): Date {
  if (typeof value === 'number') return new Date(value)
  const num = Number(value)
  return Number.isFinite(num) ? new Date(num) : new Date(value)
}

export function HomeConnections({ agentSlug, onOpenSettings }: HomeConnectionsProps) {
  const { data: accountsData } = useAgentConnectedAccounts(agentSlug)
  const { data: mcpsData } = useAgentRemoteMcps(agentSlug)

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
          iconSlug: '',
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
            Connect OAuth accounts or MCP servers to give your agent access to external services like Gmail or Slack.
          </p>
        </div>
      )}
      <div className="flex items-center justify-between mt-3 px-4 pb-1">
        {connections.length === 0 && (
          <div className="flex items-center">
            {['gmail', 'slack', 'notion', 'github', 'linear', 'figma', 'jira', 'salesforce'].map((slug, i) => (
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
          </div>
        )}
        <div className="ml-auto">
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add connection
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-1">
            <button
              className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
              onClick={() => onOpenSettings?.('connected-accounts')}
            >
              OAuth Account
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            <button
              className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
              onClick={() => onOpenSettings?.('remote-mcps')}
            >
              MCP Server
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            <div className="border-t mt-1 pt-1.5 px-2 pb-1.5">
              <p className="text-[11px] text-muted-foreground leading-snug">
                Your agent will also prompt you to add connections while chatting.
              </p>
            </div>
          </PopoverContent>
        </Popover>
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

  const isRemoving = removeAccount.isPending || removeMcp.isPending

  const handleRemove = () => {
    if (conn.type === 'oauth') {
      removeAccount.mutate({ agentSlug, accountId: conn.rawId })
    } else {
      removeMcp.mutate({ agentSlug, mcpId: conn.rawId })
    }
  }

  return (
    <>
      <button
        onClick={onConfigure}
        className="group relative w-full py-3 px-4 text-left hover:bg-muted/50 transition-colors"
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
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-0.5">
              <span className="truncate">{conn.type}{conn.subtitle ? ` · ${conn.subtitle}` : ''}</span>
              <span className="whitespace-nowrap shrink-0 ml-2">
                {formatDistanceToNow(safeDate(conn.date), { addSuffix: true })}
              </span>
            </div>
          </div>
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
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
        </div>
      </button>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Connection</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove &quot;{conn.name}&quot; from this agent? The connection itself will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
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
