import { useParams, useSearch } from '@tanstack/react-router'
import { ChatIntegrationView } from '@renderer/components/chat-integrations/chat-integration-view'
import { useAgentSlug } from './use-agent-slug'

export function ChatRoute() {
  const slug = useAgentSlug()
  const { integrationId } = useParams({ strict: false }) as { integrationId?: string }
  const search = useSearch({ strict: false }) as { session?: unknown; newchat?: unknown }
  const chatSessionId = typeof search.session === 'string' ? search.session : null
  const chatNewConvId = typeof search.newchat === 'string' ? search.newchat : null
  if (!slug || !integrationId) return null
  return (
    <ChatIntegrationView
      integrationId={integrationId}
      agentSlug={slug}
      chatSessionId={chatSessionId}
      chatNewConvId={chatNewConvId}
    />
  )
}
