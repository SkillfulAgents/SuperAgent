import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { SessionView } from '@renderer/components/layout/session-view'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePendingMessages, type PendingMessagesContextValue } from '@renderer/context/pending-messages-context'
import { isVoiceModeActive, useIsVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { useAgentSlug } from './use-agent-slug'

interface ViewState {
  agentSlug: string
  sessionId: string | null
  key: number
}

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
  const [view, setView] = useState<ViewState>({ agentSlug, sessionId, key: 0 })
  // A session left while in voice mode stays mounted, hidden, so the
  // conversation carries on from its floating composer.
  const [parked, setParked] = useState<ViewState | null>(null)
  useLayoutEffect(() => { createdSessionId.current = null }, [agentSlug, sessionId])

  if (view.agentSlug !== agentSlug || view.sessionId !== sessionId) {
    // Only this draft's own first send retains its view. Opening another
    // session (or a fresh draft) resets previews, voice, and composer state.
    const adopting = view.agentSlug === agentSlug && view.sessionId === null && sessionId === createdSessionId.current
    const nextParked = parked?.agentSlug === agentSlug ? parked : null
    if (adopting) {
      setView({ agentSlug, sessionId, key: view.key })
    } else if (nextParked && nextParked.sessionId === sessionId) {
      setView(nextParked)
      setParked(null)
    } else {
      const parking = view.agentSlug === agentSlug && isVoiceModeActive(view.sessionId)
      setParked(parking ? view : nextParked)
      setView({ agentSlug, sessionId, key: Math.max(view.key, nextParked?.key ?? 0) + 1 })
    }
  }

  const parkedVoiceOn = useIsVoiceModeActive(parked?.sessionId)
  useEffect(() => {
    if (parked && !parkedVoiceOn) setParked(null)
  }, [parked, parkedVoiceOn])

  const handleSessionCreated = useCallback<PendingMessagesContextValue['onSessionCreated']>((id, message, uuid, options) => {
    createdSessionId.current = id
    onSessionCreated(id, message, uuid, { ...options, replace: true })
  }, [onSessionCreated])

  if (!agentSlug || !agent) return null
  const views = parked ? [parked, view] : [view]
  return (
    <>
      {views.map((v) => {
        const background = v !== view
        return (
          <div
            key={v.key}
            className={background ? 'pointer-events-none invisible fixed inset-0 -z-10' : 'contents'}
            aria-hidden={background || undefined}
            data-testid={background ? 'background-session-view' : undefined}
          >
            <SessionView agentSlug={v.agentSlug} sessionId={v.sessionId} onSessionCreated={handleSessionCreated} background={background} />
          </div>
        )
      })}
    </>
  )
}
