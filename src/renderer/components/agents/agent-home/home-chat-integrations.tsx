import { useState } from 'react'
import { MessageCircle, MoreVertical, Pause, Trash2, Plus, Pencil } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Switch } from '@renderer/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
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
import { useChatIntegrations, useUpdateChatIntegration, useDeleteChatIntegration } from '@renderer/hooks/use-chat-integrations'
import { formatProviderName } from '@shared/lib/chat-integrations/utils'
import { parseChatIntegrationConfig, type ChatProvider, type SlackConfig } from '@shared/lib/chat-integrations/config-schema'
import { IntegrationRow } from '@renderer/components/connections/integration-row'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { ChatIntegrationSetupDialog } from '@renderer/components/chat-integrations/chat-integration-setup-dialog'
import { useSelection } from '@renderer/context/selection-context'
import { HomeCollapsible } from './home-collapsible'

interface HomeChatIntegrationsProps {
  agentSlug: string
}

const PROVIDER_TILES: Array<{ slug: ChatProvider; label: string; icon: React.ReactNode | null }> = [
  { slug: 'telegram', label: 'Telegram', icon: null },
  { slug: 'slack', label: 'Slack', icon: null },
  { slug: 'imessage', label: 'iMessage', icon: <MessageCircle className="h-4 w-4 text-[#007AFF]" fill="#007AFF" stroke="none" /> },
]

function ToggleRow({ label, checked, onCheckedChange, disabled, ariaLabel }: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <div className="flex w-full items-center justify-between px-2 py-1.5">
      <span className="text-xs">{label}</span>
      <Switch
        className="scale-75 origin-right"
        checked={checked}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel ?? label}
      />
    </div>
  )
}


function statusBadge(status: string) {
  switch (status) {
    case 'paused':
      return <span className="text-2xs px-1.5 py-0 rounded-full bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">Paused</span>
    case 'error':
      return <span className="text-2xs px-1.5 py-0 rounded-full bg-red-500/10 text-red-700 dark:text-red-400">Error</span>
    case 'disconnected':
      return <span className="text-2xs px-1.5 py-0 rounded-full bg-gray-500/10 text-gray-700 dark:text-gray-400">Disconnected</span>
    default:
      return null
  }
}

export function HomeChatIntegrations({ agentSlug }: HomeChatIntegrationsProps) {
  const { data: integrations } = useChatIntegrations(agentSlug)
  const { setView } = useSelection()
  const updateIntegration = useUpdateChatIntegration()
  const deleteIntegration = useDeleteChatIntegration()
  const rows = Array.isArray(integrations) ? integrations : []
  const [setupProvider, setSetupProvider] = useState<ChatProvider | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  return (
    <HomeCollapsible title="Remote Chat">
      {rows.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {rows.map((integration) => {
            const isPaused = integration.status === 'paused'
            const displayName = integration.name || `${formatProviderName(integration.provider)} Bot`
            return (
              <IntegrationRow
                key={integration.id}
                iconSlug={integration.provider}
                iconFallback="mcp"
                name={displayName}
                nameBadge={statusBadge(integration.status)}
                subtitle={
                  <span className="capitalize">{formatProviderName(integration.provider)}</span>
                }
                onActivate={() => setView({ kind: 'chat', integrationId: integration.id })}
                right={
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                        aria-label={`Actions for ${displayName}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-48 p-1">
                      <div className="flex w-full items-center justify-between px-2 py-1.5">
                        <div
                          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${
                            isPaused
                              ? 'bg-muted text-muted-foreground'
                              : 'bg-green-500/10 text-green-700 dark:text-green-400'
                          }`}
                        >
                          {isPaused ? (
                            <Pause className="h-2.5 w-2.5 fill-current" />
                          ) : (
                            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                          )}
                          {isPaused ? 'Paused' : 'Active'}
                        </div>
                        <Switch
                          className="scale-75 origin-right"
                          checked={!isPaused}
                          disabled={updateIntegration.isPending}
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={() =>
                            updateIntegration.mutate({
                              id: integration.id,
                              status: isPaused ? 'active' : 'paused',
                            })
                          }
                          aria-label={isPaused ? 'Resume integration' : 'Pause integration'}
                        />
                      </div>
                      <div className="my-1 h-px bg-border" />
                      <ToggleRow
                        label="Show tool calls"
                        checked={!!integration.showToolCalls}
                        disabled={updateIntegration.isPending}
                        onCheckedChange={(checked) =>
                          updateIntegration.mutate({ id: integration.id, showToolCalls: checked })
                        }
                      />
                      {integration.provider === 'slack' && (() => {
                        const config = parseChatIntegrationConfig('slack', integration.config) as SlackConfig | null
                        if (!config) return null
                        return (
                          <>
                            <ToggleRow
                              label="Only on @mention"
                              checked={!!config.onlyMentioned}
                              disabled={updateIntegration.isPending}
                              onCheckedChange={(checked) =>
                                updateIntegration.mutate({
                                  id: integration.id,
                                  config: { ...config, onlyMentioned: checked },
                                })
                              }
                            />
                            <ToggleRow
                              label="Reply in thread"
                              checked={!!config.answerInThread}
                              disabled={updateIntegration.isPending}
                              onCheckedChange={(checked) =>
                                updateIntegration.mutate({
                                  id: integration.id,
                                  config: { ...config, answerInThread: checked, ...(!checked ? { newSessionPerThread: false } : {}) },
                                })
                              }
                            />
                            {!!config.answerInThread && (
                              <ToggleRow
                                label="New session per thread"
                                checked={!!config.newSessionPerThread}
                                disabled={updateIntegration.isPending}
                                onCheckedChange={(checked) =>
                                  updateIntegration.mutate({
                                    id: integration.id,
                                    config: { ...config, newSessionPerThread: checked },
                                  })
                                }
                              />
                            )}
                          </>
                        )
                      })()}
                      <div className="my-1 h-px bg-border" />
                      <button
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenameValue(integration.name || '')
                          setRenameTarget({ id: integration.id, name: displayName })
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Rename
                      </button>
                      <button
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget({ id: integration.id, name: displayName })
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </PopoverContent>
                  </Popover>
                }
              />
            )
          })}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">Not configured yet</p>
          <p className="text-xs mt-1">
            Connect messaging to chat with this agent from anywhere.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {PROVIDER_TILES.map((tile) => (
              <button
                key={tile.slug}
                onClick={() => setSetupProvider(tile.slug)}
                aria-label={`Chat via ${tile.label}`}
                className="flex items-center gap-2 rounded-lg border border-border bg-background p-2 shadow-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background dark:bg-zinc-200 shadow-sm">
                  {tile.icon ?? <ServiceIcon slug={tile.slug} fallback="mcp" className="h-4 w-4" />}
                </div>
                <div className="flex flex-col items-start">
                  <span className="text-2xs font-normal text-muted-foreground">Chat via</span>
                  <span className="text-xs font-normal text-foreground">{tile.label}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <div className="flex items-center justify-between mt-1 px-4 pb-1">
          <div className="ml-auto">
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  <Plus /> Add Integration
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-1">
                {PROVIDER_TILES.map((tile) => (
                  <button
                    key={tile.slug}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                    onClick={() => setSetupProvider(tile.slug)}
                  >
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background dark:bg-zinc-200">
                      {tile.icon ?? <ServiceIcon slug={tile.slug} fallback="mcp" className="h-3 w-3" />}
                    </div>
                    {tile.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}
      <ChatIntegrationSetupDialog
        agentSlug={agentSlug}
        provider={setupProvider}
        onOpenChange={(open) => { if (!open) setSetupProvider(null) }}
      />

      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null) }}>
        <DialogContent className="overflow-hidden">
          <DialogHeader>
            <DialogTitle>Rename Integration</DialogTitle>
            <DialogDescription>Enter a new name for this integration.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!renameTarget) return
              const trimmed = renameValue.trim()
              updateIntegration.mutate(
                { id: renameTarget.id, name: trimmed },
                { onSuccess: () => setRenameTarget(null) },
              )
            }}
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Integration name"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button type="submit" disabled={updateIntegration.isPending}>
                {updateIntegration.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Integration</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteTarget?.name}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) {
                  deleteIntegration.mutate({ id: deleteTarget.id, agentSlug })
                  setDeleteTarget(null)
                }
              }}
              disabled={deleteIntegration.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteIntegration.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </HomeCollapsible>
  )
}
