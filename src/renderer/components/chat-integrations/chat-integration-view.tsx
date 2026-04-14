/**
 * Chat Integration View
 *
 * Shows the session thread for a chat integration in read-only mode,
 * with a banner indicating the session is controlled from an external chat.
 */

import { useState } from 'react'
import { MessageCircle, Trash2, Loader2, Pause, Play, ExternalLink, RotateCcw, AlertTriangle } from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { MessageList } from '@renderer/components/messages/message-list'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
import { Button } from '@renderer/components/ui/button'
import {
  useChatIntegration,
  useDeleteChatIntegration,
  useUpdateChatIntegration,
  useChatIntegrationStatus,
  useChatIntegrationSessions,
  useClearChatSession,
} from '@renderer/hooks/use-chat-integrations'
import { useSelection } from '@renderer/context/selection-context'
import { useUser } from '@renderer/context/user-context'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@renderer/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { formatProviderName } from '@shared/lib/chat-integrations/utils'

interface ChatIntegrationViewProps {
  integrationId: string
  agentSlug: string
}

export function ChatIntegrationView({ integrationId, agentSlug }: ChatIntegrationViewProps) {
  const { data: integration, isLoading, error } = useChatIntegration(integrationId)
  const { data: status } = useChatIntegrationStatus(integrationId)
  const { data: sessions } = useChatIntegrationSessions(integrationId)
  const deleteIntegration = useDeleteChatIntegration()
  const updateIntegration = useUpdateChatIntegration()
  const clearSession = useClearChatSession()
  const { selectedChatSessionId, handleChatIntegrationDeleted, selectChatSession } = useSelection()
  const { canUseAgent } = useUser()
  const canManage = canUseAgent(agentSlug)
  const [clearError, setClearError] = useState<string | null>(null)

  const handleDelete = async () => {
    try {
      await deleteIntegration.mutateAsync({ id: integrationId, agentSlug })
      handleChatIntegrationDeleted(integrationId)
    } catch (err) {
      console.error('Failed to delete chat integration:', err)
    }
  }

  const handleTogglePause = async () => {
    if (!integration) return
    const newStatus = integration.status === 'paused' ? 'active' : 'paused'
    await updateIntegration.mutateAsync({ id: integrationId, status: newStatus as 'active' | 'paused' })
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
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTogglePause}
                disabled={updateIntegration.isPending}
              >
                {integration.status === 'paused' ? (
                  <><Play className="h-4 w-4 mr-2" /> Resume</>
                ) : (
                  <><Pause className="h-4 w-4 mr-2" /> Pause</>
                )}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
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
                      {deleteIntegration.isPending ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Deleting...</>
                      ) : (
                        'Delete Integration'
                      )}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
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
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Session selector + read-only banner */}
            <div className="shrink-0 border-b bg-muted/50 px-4 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <MessageCircle className="h-3 w-3 shrink-0" />
                {sessions && sessions.length > 1 ? (
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <select
                      value={activeSessionId}
                      onChange={(e) => selectChatSession(integrationId, e.target.value)}
                      aria-label="Select chat session"
                      className="bg-transparent border rounded px-1.5 py-0.5 text-xs text-muted-foreground cursor-pointer"
                    >
                      {sessions.map((s) => (
                        <option key={s.id} value={s.sessionId}>
                          {s.displayName || `Chat ${s.externalChatId.slice(-6)}`}{s.archivedAt ? ' (archived)' : ''}
                        </option>
                      ))}
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
            {/* Chat column — grid pins the footer at the bottom */}
            <div className="flex-1 min-w-0 min-h-0 grid grid-rows-[1fr_auto]">
              <MessageList
                sessionId={activeSessionId}
                agentSlug={agentSlug}
              />
              <div className="bg-background">
                <AgentActivityIndicator sessionId={activeSessionId} agentSlug={agentSlug} />
                <div className="px-4 py-3 border-t">
                  <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    <MessageCircle className="h-4 w-4 shrink-0" />
                    Send messages from {providerName} to chat with this agent
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
