/**
 * Chat Integration View
 *
 * Shows the session thread for a chat integration in read-only mode,
 * with a banner indicating the session is controlled from an external chat.
 */

import { useState } from 'react'
import { MessageCircle, MoreVertical, Loader2, ExternalLink, RotateCcw, AlertTriangle } from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { SessionThread } from '@renderer/components/messages/session-thread'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  useChatIntegration,
  useDeleteChatIntegration,
  useUpdateChatIntegration,
  useChatIntegrationStatus,
  useChatIntegrationSessions,
  useClearChatSession,
} from '@renderer/hooks/use-chat-integrations'
import { formatSessionTimestamp } from '@shared/lib/chat-integrations/utils'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
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
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { IntegrationSettingsMenu } from '@renderer/components/chat-integrations/integration-settings-menu'
import { formatProviderName } from '@shared/lib/chat-integrations/utils'

interface ChatIntegrationViewProps {
  integrationId: string
  agentSlug: string
  /** Active sub-session from the route's `?session=` search (null = latest). */
  chatSessionId: string | null
}

export function ChatIntegrationView({ integrationId, agentSlug, chatSessionId }: ChatIntegrationViewProps) {
  const { data: integration, isLoading, error } = useChatIntegration(integrationId)
  const { data: status } = useChatIntegrationStatus(integrationId)
  const { data: sessions } = useChatIntegrationSessions(integrationId)
  const deleteIntegration = useDeleteChatIntegration()
  const updateIntegration = useUpdateChatIntegration()
  const clearSession = useClearChatSession()
  const navigate = useNavigate()
  // The active sub-session comes from the URL search now (deep-linkable).
  const selectedChatSessionId = chatSessionId
  const { canUseAgent } = useUser()
  const canManage = canUseAgent(agentSlug)
  const [clearError, setClearError] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const handleDelete = async () => {
    try {
      await deleteIntegration.mutateAsync({ id: integrationId, agentSlug })
      // Always invoked while viewing this integration's route → up-nav home.
      void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
    } catch (err) {
      console.error('Failed to delete chat integration:', err)
    }
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading chat integration...
      </div>
    )
  }

  if (error || !integration) {
    return (
      <div className="flex-1 flex items-center justify-center text-destructive">
        Failed to load chat integration
      </div>
    )
  }

  const providerName = formatProviderName(integration.provider)
  const statusColor = status?.connected ? 'text-green-500' : 'text-gray-400'

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Integration header */}
      <div className="p-6 border-b">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold mb-2">
              <ServiceIcon slug={integration.provider} fallback="mcp" className="h-6 w-6" />
              {integration.name || `${providerName} Bot`}
            </h2>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <MessageCircle className="h-4 w-4" />
                <span>{providerName}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className={`inline-block w-2 h-2 rounded-full ${
                  integration.status === 'active' ? 'bg-green-500' :
                  integration.status === 'paused' ? 'bg-yellow-500' :
                  integration.status === 'error' ? 'bg-red-500' : 'bg-gray-400'
                }`} />
                <span className="capitalize">{integration.status}</span>
              </div>
              {status && (
                <div className={`flex items-center gap-1 ${statusColor}`}>
                  <ExternalLink className="h-3 w-3" />
                  <span className="text-xs">{status.connected ? 'Connected' : 'Disconnected'}</span>
                </div>
              )}
            </div>
            {integration.errorMessage && (
              <p className="text-xs text-red-500 mt-2">{integration.errorMessage}</p>
            )}
          </div>

          {canManage && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" size="icon" variant="outline" className="h-8 w-8" aria-label="Integration settings">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-1">
                <IntegrationSettingsMenu
                  integration={integration}
                  onRename={() => {
                    setRenameValue(integration.name || '')
                    setRenameOpen(true)
                  }}
                  onDelete={() => setDeleteConfirmOpen(true)}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {/* Session thread (read-only) or empty state */}
      {(() => {
        // Determine which session to show: selected, or the most recent one
        const activeSessionId = selectedChatSessionId
          || sessions?.[sessions.length - 1]?.sessionId

        if (!activeSessionId) {
          return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
              <MessageCircle className="h-12 w-12 text-muted-foreground/30" />
              <div>
                <p className="text-sm font-medium text-muted-foreground">No active sessions</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Send a message from {providerName} to start a new session with this agent.
                </p>
              </div>
            </div>
          )
        }

        const activeSession = sessions?.find(s => s.sessionId === activeSessionId)
        const isArchived = activeSession?.archivedAt != null

        return (
          <FilePreviewProvider sessionId={activeSessionId}>
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Session selector + read-only banner */}
            <div className="shrink-0 border-b bg-muted/50 px-4 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <MessageCircle className="h-3 w-3 shrink-0" />
                {sessions && sessions.length > 1 ? (
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <select
                      value={activeSessionId}
                      onChange={(e) => {
                        const sessionId = e.target.value
                        // Push (not replace): each sub-session is a real history
                        // entry so Back walks them (migration plan §7.3).
                        void navigate({
                          to: '/agents/$slug/chat/$integrationId',
                          params: { slug: agentSlug, integrationId },
                          search: { session: sessionId },
                        })
                      }}
                      aria-label="Select chat session"
                      className="bg-transparent border rounded px-1.5 py-0.5 text-xs text-muted-foreground cursor-pointer"
                    >
                      {sessions.map((s) => {
                        const label = s.displayName || `Chat ${s.externalChatId.slice(-6)}`
                        const ts = s.createdAt ? formatSessionTimestamp(new Date(s.createdAt)) : ''
                        const suffix = s.archivedAt ? ' (archived)' : ''
                        return (
                          <option key={s.id} value={s.sessionId}>
                            {label}{ts ? ` — ${ts}` : ''}{suffix}
                          </option>
                        )
                      })}
                    </select>
                    <span className="text-muted-foreground/70">
                      {isArchived ? '— archived session' : `— controlled from ${providerName}`}
                    </span>
                  </div>
                ) : (
                  <span className="flex-1">
                    {activeSession?.displayName ? `${activeSession.displayName} — ` : ''}
                    {isArchived
                      ? 'This session has been archived. Next message from chat will start a new session.'
                      : `This session is controlled from ${providerName}. Messages can only be sent from the connected chat.`
                    }
                  </span>
                )}
                {activeSession && canManage && !isArchived && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={async () => {
                      setClearError(null)
                      try {
                        await clearSession.mutateAsync({ integrationId, sessionId: activeSession.id })
                      } catch (err) {
                        setClearError(err instanceof Error ? err.message : 'Failed to clear session')
                      }
                    }}
                    disabled={clearSession.isPending}
                    title="Clear session context — next message from chat will start fresh"
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Clear Session
                  </Button>
                )}
              </div>
            </div>
            {clearError && (
              <Alert variant="destructive" className="mx-4 mt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{clearError}</AlertDescription>
              </Alert>
            )}
            <SessionThread
              sessionId={activeSessionId}
              agentSlug={agentSlug}
              footer={
                <div className="px-4 py-3 border-t">
                  <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    <MessageCircle className="h-4 w-4 shrink-0" />
                    Send messages from {providerName} to chat with this agent
                  </div>
                </div>
              }
            />
          </div>
          </FilePreviewProvider>
        )
      })()}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Chat Integration</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect the bot and remove this integration permanently.
              Existing session history will be preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteIntegration.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteIntegration.isPending ? 'Deleting...' : 'Delete Integration'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="overflow-hidden">
          <DialogHeader>
            <DialogTitle>Rename Integration</DialogTitle>
            <DialogDescription>Enter a new name for this integration.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = renameValue.trim()
              updateIntegration.mutate(
                { id: integrationId, name: trimmed },
                { onSuccess: () => setRenameOpen(false) },
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
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={updateIntegration.isPending}>
                {updateIntegration.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
