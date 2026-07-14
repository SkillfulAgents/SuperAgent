import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDraftsStore } from '@renderer/context/drafts-context'
import {
  newSessionCarryoverKey,
  splitComposerSnapshot,
  type ComposerSnapshot,
} from '@renderer/lib/new-session-carryover'
import { computeContextTokens } from '@shared/lib/utils/context-usage'
import { shouldPromptForNewSession } from '@shared/lib/stale-session/stale-session-trigger'
import type { SessionUsage } from '@shared/lib/types/agent'

interface UseStaleSessionArgs {
  sessionId: string
  /** Canonical agent ID used by the destination composer's draft keys. */
  agentSlug: string
  /** Decorative route slug to preserve in the destination URL. */
  routeAgentSlug?: string
  isActive: boolean
  isWaitingBackground: boolean
  isAwaitingInput: boolean
  isViewOnly: boolean
  lastActivityAt?: Date | null
  contextUsage?: SessionUsage | null
}

/** Detection and draft handoff for the old/large-session prompt. */
export function useStaleSession({
  sessionId,
  agentSlug,
  routeAgentSlug,
  isActive,
  isWaitingBackground,
  isAwaitingInput,
  isViewOnly,
  lastActivityAt,
  contextUsage,
}: UseStaleSessionArgs) {
  const navigate = useNavigate()
  const draftsStore = useDraftsStore()
  const [ignored, setIgnored] = useState(false)
  const [learnMoreOpen, setLearnMoreOpen] = useState(false)
  const [liveActivityAt, setLiveActivityAt] = useState<number | null>(null)
  const wasActiveRef = useRef(isActive)
  const composerSnapshotRef = useRef<(() => ComposerSnapshot) | null>(null)

  // Persisted activity can lag a just-completed turn. Stamp active -> idle locally
  // so the prompt does not immediately return after the user continues the session.
  useEffect(() => {
    if (isActive || wasActiveRef.current) setLiveActivityAt(Date.now())
    wasActiveRef.current = isActive
  }, [isActive])

  // SessionChatColumn can survive a sibling-session navigation, so local prompt
  // state must be scoped explicitly to the current session.
  useEffect(() => {
    setIgnored(false)
    setLearnMoreOpen(false)
    setLiveActivityAt(null)
    wasActiveRef.current = isActive
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const shouldPrompt = useMemo(() => {
    const activityAt = Math.max(lastActivityAt?.getTime() ?? 0, liveActivityAt ?? 0)
    return shouldPromptForNewSession({
      idleMs: activityAt ? Date.now() - activityAt : 0,
      contextTokens: contextUsage ? computeContextTokens(contextUsage) : 0,
      isAwaitingInput,
      isRunning: isActive && !isWaitingBackground,
    })
  }, [contextUsage, isActive, isAwaitingInput, isWaitingBackground, lastActivityAt, liveActivityAt])

  const registerSnapshot = useCallback((getSnapshot: (() => ComposerSnapshot) | null) => {
    composerSnapshotRef.current = getSnapshot
  }, [])

  const startFresh = useCallback(() => {
    const { draftText, carryover } = splitComposerSnapshot(composerSnapshotRef.current?.())
    if (draftText !== undefined) draftsStore.set(`agent:${agentSlug}`, draftText)
    draftsStore.set(newSessionCarryoverKey(agentSlug), carryover)
    draftsStore.set(`session:${sessionId}`, undefined)
    void navigate({ to: '/agents/$slug', params: { slug: routeAgentSlug ?? agentSlug } })
  }, [agentSlug, draftsStore, navigate, routeAgentSlug, sessionId])

  return {
    showNotice: shouldPrompt && !isActive && !isViewOnly && !ignored,
    ignore: useCallback(() => setIgnored(true), []),
    learnMoreOpen,
    setLearnMoreOpen,
    registerSnapshot,
    startFresh,
  }
}
