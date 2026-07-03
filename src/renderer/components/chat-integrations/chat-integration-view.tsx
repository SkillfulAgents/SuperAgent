/**
 * Chat Integration View
 *
 * Cron-page-style layout: a max-w-5xl document with a PageTitle header
 * (agent name + provider tag, New conversation + delete actions) over a
 * two-column body - the read-only conversation inbox (left) and
 * non-collapsible settings cards (right).
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { InlineEditableTitle } from '@renderer/components/ui/inline-editable-title'
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import {
  useChatIntegration,
  useChatIntegrationStatus,
  useChatIntegrationSessions,
  useClearChatSession,
  useUpdateChatIntegration,
} from '@renderer/hooks/use-chat-integrations'
import { useAgent, useAgents, resolveRouteAgentId } from '@renderer/hooks/use-agents'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { formatProviderName } from '@shared/lib/chat-integrations/utils'
import { chatFallbackTitle } from './chat-inbox-model'
import { ConversationHistorySection } from './conversation-history-section'
import { ChatIntegrationSidePanel } from './chat-integration-side-panel'
import { ClearConversationButton } from './clear-conversation-button'
import { IntegrationDeleteButton } from './integration-delete-button'

interface ChatIntegrationViewProps {
  integrationId: string
  agentSlug: string
  /** Open conversation window from the route's `?session=` search (null = list). */
  chatSessionId: string | null
  /** externalChatId of a chat opened to a fresh conversation (`?newchat=`), or null. */
  chatNewConvId: string | null
}

export function ChatIntegrationView({ integrationId, agentSlug, chatSessionId, chatNewConvId }: ChatIntegrationViewProps) {
  const { data: integration, isLoading, error } = useChatIntegration(integrationId)
  const { data: status } = useChatIntegrationStatus(integrationId)
  const { data: sessions } = useChatIntegrationSessions(integrationId)
  const { data: agent } = useAgent(agentSlug)
  const { data: agents } = useAgents()
  const clearSession = useClearChatSession()
  const updateIntegration = useUpdateChatIntegration()
  const navigate = useNavigate()
  const { canUseAgent, canAdminAgent } = useUser()
  const canManage = canUseAgent(agentSlug)
  // Access decisions and the make-public toggle are owner-only (server enforces too).
  const canManageAccess = canAdminAgent(agentSlug)

  const [clearError, setClearError] = useState<string | null>(null)

  // The header "New conversation" archives a live conversation so the chat's
  // next message starts fresh. Its target: the conversation being viewed when
  // one is open (`?session=`), else the most recently active live one - the
  // right chat for the common single-chat bot, and the confirm dialog names it
  // so multi-chat integrations never reset the wrong person by surprise.
  const liveSessions = (sessions ?? []).filter((s) => s.archivedAt == null)
  const openLive = chatSessionId ? liveSessions.find((s) => s.sessionId === chatSessionId) : undefined
  const mostRecentLive = liveSessions.length > 0
    ? liveSessions.reduce((a, b) => (new Date(a.updatedAt) >= new Date(b.updatedAt) ? a : b))
    : undefined
  const targetSession = openLive ?? mostRecentLive
  const showNewConversation = canManage && !!targetSession

  // Read inside the async clear .then() so navigating mid-clear doesn't yank
  // the user to a chat they've since moved away from.
  const chatSessionIdRef = useRef<string | null>(null)
  chatSessionIdRef.current = chatSessionId

  function handleNewConversation() {
    if (!targetSession) return
    const { id: sessionRowId, externalChatId } = targetSession
    const routeAtClick = chatSessionIdRef.current
    setClearError(null)
    void clearSession
      .mutateAsync({ integrationId, sessionId: sessionRowId })
      .then(() => {
        // Show the fresh blank conversation - unless the route changed mid-clear.
        if (chatSessionIdRef.current === routeAtClick) {
          void navigate({
            to: '/agents/$slug/chat/$integrationId',
            params: { slug: agentSlug, integrationId },
            search: { newchat: externalChatId },
          })
        }
      })
      .catch((e) => setClearError(e instanceof Error ? e.message : 'Failed to clear conversation'))
  }

  // Canonicalize: integrations are addressed globally by id, so
  // /agents/<wrong>/chat/<id> would render this integration under the wrong
  // agent's shell (mismatched chrome and canManage gating, and the SessionThread
  // below fetches messages scoped to the URL slug -> empty/404). Redirect to the
  // integration's true agent, preserving the `?session=` sub-session.
  useEffect(() => {
    // Compare RESOLVED ids: the route param may be the display slug ({name}-{id})
    // while integration.agentSlug is the canonical id, so a raw `!==` would fire on
    // every correct-agent visit. Wait for the agents list, then redirect.
    if (!integration || !agents) return
    if (integration.agentSlug === resolveRouteAgentId(agentSlug, agents)) return
    void navigate({
      to: '/agents/$slug/chat/$integrationId',
      params: { slug: integration.agentSlug, integrationId },
      search: (prev) => prev,
      replace: true,
    })
  }, [integration, agents, agentSlug, integrationId, navigate])

  const canSeeSidePanel = canManage

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

  // Mismatched shell - the effect above is redirecting; don't render B's
  // integration (or its wrong-slug message fetches) under A's chrome meanwhile.
  if (agents && integration.agentSlug !== resolveRouteAgentId(agentSlug, agents)) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading chat integration...
      </div>
    )
  }

  const providerName = formatProviderName(integration.provider)
  // Custom integration name wins (matches the agent-home row list); otherwise
  // fall back to the agent's name, same as the row list's fallback.
  const displayName = integration.name || (agent?.name ?? agentSlug)

  const headerActions = (showNewConversation || canManage) ? (
    <div className="flex items-center gap-2">
      {showNewConversation && (
        <ClearConversationButton
          providerName={providerName}
          chatTitle={targetSession ? (targetSession.displayName ?? chatFallbackTitle(targetSession.externalChatId)) : undefined}
          pending={clearSession.isPending}
          onConfirm={handleNewConversation}
        />
      )}
      {canManage && (
        <IntegrationDeleteButton
          integration={integration}
          onDeleted={() => void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })}
        />
      )}
    </div>
  ) : undefined

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title={
          <div className="flex items-center gap-2 min-w-0">
            <InlineEditableTitle
              value={displayName}
              canEdit={canManage}
              isSaving={updateIntegration.isPending}
              onSave={async (name) => {
                await updateIntegration.mutateAsync({ id: integration.id, name })
              }}
              onError={(error) => {
                console.error('Failed to rename integration:', error)
                toast.error('Failed to rename integration', {
                  description: error instanceof Error ? error.message : 'Please try again.',
                })
              }}
              readOnlyAs="h2"
              displayClassName="text-xl font-medium"
              inputClassName="h-9 text-xl font-medium"
              saveButtonClassName="h-8 w-8"
              ariaLabel="Rename integration"
              saveAriaLabel="Save name"
              displayTestId="integration-name"
              inputTestId="integration-name-input"
            />
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-1 text-xs">
              <ServiceIcon slug={integration.provider} fallback="mcp" className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium">{providerName}</span>
              <span className="text-muted-foreground">Remote Chat</span>
            </span>
          </div>
        }
        back={{ onClick: () => void navigate({ to: '/agents/$slug', params: { slug: agentSlug } }) }}
        actions={headerActions}
      />

      {integration.errorMessage && (
        <p className="text-xs text-red-500">{integration.errorMessage}</p>
      )}
      {clearError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{clearError}</AlertDescription>
        </Alert>
      )}

      <div className={`grid grid-cols-1 gap-y-6 ${canSeeSidePanel ? 'lg:grid-cols-[3fr_2fr] lg:gap-x-10 lg:gap-y-0' : ''}`}>
        <div>
          <ConversationHistorySection
            integration={integration}
            sessions={sessions}
            routeSessionId={chatSessionId}
            routeNewChatId={chatNewConvId}
            onSelectWindow={(sessionId) =>
              void navigate({
                to: '/agents/$slug/chat/$integrationId',
                params: { slug: agentSlug, integrationId },
                search: sessionId ? { session: sessionId } : {},
              })
            }
            onNewConversation={(externalChatId) =>
              void navigate({
                to: '/agents/$slug/chat/$integrationId',
                params: { slug: agentSlug, integrationId },
                search: { newchat: externalChatId },
              })
            }
            agentSlug={agentSlug}
            providerName={providerName}
            canManageAccess={canManageAccess}
          />
        </div>

        {canSeeSidePanel && (
          <ChatIntegrationSidePanel
            integration={integration}
            connected={status?.connected}
            canManage={canManage}
            canManageAccess={canManageAccess}
          />
        )}
      </div>
    </SettingsPageContainer>
  )
}
