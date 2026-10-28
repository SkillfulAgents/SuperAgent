import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { useForkAndCompact } from '@renderer/hooks/use-sessions'
import {
  newSessionCarryoverKey,
  splitComposerSnapshot,
  type ComposerSnapshot,
} from '@renderer/lib/new-session-carryover'
import { computeContextTokens } from '@shared/lib/utils/context-usage'
import { shouldPromptForNewSession } from '@shared/lib/stale-session/stale-session-trigger'
import { STALE_TIME_GAP_MS } from '@shared/lib/stale-session/stale-session-config'
import type { SessionUsage } from '@shared/lib/types/agent'

// setTimeout fires at once for a longer delay.
const MAX_TIMEOUT_MS = 2 ** 31 - 1

interface UseStaleSessionArgs {
  sessionId: string | null
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
  const { mutate: forkAndCompact, isPending } = useForkAndCompact()
  const [ignored, setIgnored] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [liveActivityAt, setLiveActivityAt] = useState<number | null>(null)
  const wasActiveRef = useRef(isActive)
  const composerSnapshotRef = useRef<(() => ComposerSnapshot) | null>(null)
  const forkInFlightRef = useRef(false)

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
    setPopoverOpen(false)
    setLiveActivityAt(null)
    wasActiveRef.current = isActive
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const activityAt = Math.max(lastActivityAt?.getTime() ?? 0, liveActivityAt ?? 0)

  // The idle gap is read from the clock, and an idle session gives nothing else a
  // reason to re-render. Re-render once the gap crosses the threshold; a timer that
  // fires early (or is capped below setTimeout's limit) just schedules the rest.
  const [clockCheck, setClockCheck] = useState(0)
  useEffect(() => {
    if (!activityAt) return
    const remaining = activityAt + STALE_TIME_GAP_MS - Date.now()
    if (remaining < 0) return
    const timer = setTimeout(() => setClockCheck((n) => n + 1), Math.min(remaining + 1, MAX_TIMEOUT_MS))
    return () => clearTimeout(timer)
  }, [activityAt, clockCheck])

  const shouldPrompt = shouldPromptForNewSession({
    idleMs: activityAt ? Date.now() - activityAt : 0,
    contextTokens: contextUsage ? computeContextTokens(contextUsage) : 0,
    isAwaitingInput,
    isRunning: isActive && !isWaitingBackground,
  })

  const registerSnapshot = useCallback((getSnapshot: (() => ComposerSnapshot) | null) => {
    composerSnapshotRef.current = getSnapshot
  }, [])

  const startFresh = useCallback(() => {
    if (!sessionId || forkInFlightRef.current) return
    const { draftText, carryover } = splitComposerSnapshot(composerSnapshotRef.current?.())
    if (draftText !== undefined) draftsStore.set(`agent:${agentSlug}`, draftText)
    draftsStore.set(newSessionCarryoverKey(agentSlug), carryover)
    draftsStore.set(`session:${sessionId}`, undefined)
    void navigate({ to: '/agents/$slug', params: { slug: routeAgentSlug ?? agentSlug } })
  }, [agentSlug, draftsStore, navigate, routeAgentSlug, sessionId])

  // Continue in a compacted copy. The display slug goes to the fork so the
  // copy's URL keeps it, as startFresh does.
  const continueCompacted = useCallback(() => {
    // Guard synchronously: a second selection can arrive before isPending renders.
    if (!sessionId || forkInFlightRef.current) return
    forkInFlightRef.current = true
    forkAndCompact(
      { sessionId, agentSlug: routeAgentSlug ?? agentSlug },
      { onSettled: () => { forkInFlightRef.current = false } },
    )
  }, [agentSlug, forkAndCompact, routeAgentSlug, sessionId])

  return {
    showNotice: !!sessionId && shouldPrompt && !isActive && !isViewOnly && !ignored,
    isPending,
    ignore: useCallback(() => setIgnored(true), []),
    popoverOpen,
    setPopoverOpen,
    registerSnapshot,
    startFresh,
    continueCompacted,
  }
}
