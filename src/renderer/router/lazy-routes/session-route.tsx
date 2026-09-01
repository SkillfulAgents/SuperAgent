import { useParams, useSearch } from '@tanstack/react-router'
import { SessionView } from '@renderer/components/layout/session-view'
import { useAgentSlug } from './use-agent-slug'

export function SessionRoute() {
  const slug = useAgentSlug()
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  const search = useSearch({ strict: false }) as { mention?: string }
  if (!slug || !sessionId) return null
  return <SessionView agentSlug={slug} sessionId={sessionId} inboxMessageUuid={search.mention} />
}
