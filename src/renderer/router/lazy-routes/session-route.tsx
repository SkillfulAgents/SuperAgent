import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { SessionView } from '@renderer/components/layout/session-view'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePendingMessages, type PendingMessagesContextValue } from '@renderer/context/pending-messages-context'
import { useAgentSlug } from './use-agent-slug'

export function SessionRoute() {
  const slug = useAgentSlug()
  const { data: agent } = useAgent(slug)
  const { sessionId: routeSessionId } = useParams({ strict: false }) as { sessionId?: string }
  const sessionId = routeSessionId ?? null
  const agentSlug = agent?.slug ?? slug
  const { onSessionCreated } = usePendingMessages()
  // Navigation updates an external store and can render before queued React
  // state. Mark the handoff synchronously so that render keeps the same key.
  const createdSessionId = useRef<string | null>(null)
  const [view, setView] = useState({ agentSlug, sessionId, key: 0 })
  useLayoutEffect(() => { createdSessionId.current = null }, [agentSlug, sessionId])

  if (view.agentSlug !== agentSlug || view.sessionId !== sessionId) {
    // Only this draft's own first send retains its view. Opening another
    // session (or a fresh draft) resets previews, voice, and composer state.
    const adopting = view.agentSlug === agentSlug && view.sessionId === null && sessionId === createdSessionId.current
    setView({ agentSlug, sessionId, key: adopting ? view.key : view.key + 1 })
  }

  const handleSessionCreated = useCallback<PendingMessagesContextValue['onSessionCreated']>((id, message, uuid, options) => {
    createdSessionId.current = id
    onSessionCreated(id, message, uuid, { ...options, replace: true })
  }, [onSessionCreated])

  if (!agentSlug || !agent) return null
  return <SessionView key={view.key} agentSlug={agentSlug} sessionId={sessionId} onSessionCreated={handleSessionCreated} />
}
