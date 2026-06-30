import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { splitSnapshotForHandoff, carryoverKey, type ComposerSnapshot } from '@renderer/lib/composer-carryover'
import { evaluateStalePrompt } from '@shared/lib/stale-session/stale-session-trigger'
import { currentContextTokens } from '@shared/lib/stale-session/message-cost'
import type { SessionUsage } from '@shared/lib/types/agent'

export interface UseStaleSessionArgs {
  sessionId: string
  agentSlug: string
  /** Session is mid-turn (running or awaiting input). */
  isActive: boolean
  /** Active only because a background task is in flight (not a foreground turn). */
  isWaitingBackground: boolean
  /** Active and blocked on a pending interactive request (secret, question, file, ...). */
  isAwaitingInput: boolean
  /** View-only users cannot start a new conversation, so they never see the prompt. */
  isViewOnly: boolean
  /** Last activity time from the session-detail query (may lag a just-finished turn). */
  lastActivityAt?: Date | null
  contextUsage?: SessionUsage | null
}

export interface UseStaleSessionResult {
  /** Whether the stale-session toast should render right now. */
  showToast: boolean
  /** Hide the toast for this mount (no persistence). */
  ignore: () => void
  /** True while the toast's Learn more popover is open; the caller suppresses the
   *  scroll-to-bottom FAB it would otherwise overlap. */
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  /** Registered by MessageInput so "Start fresh" can read the live composer state. */
  registerSnapshot: (getSnapshot: (() => ComposerSnapshot) | null) => void
  /** Snapshot the composer into the agent's new-chat composer and navigate there.
   *  No session is created until the user actually sends. */
  startFresh: () => void
}

/**
 * Stale-session detection + "Start fresh" handoff, extracted from SessionChatColumn.
 *
 * Detection is continuous (not gated on the send path): a conversation is stale
 * when it has been idle long enough AND carries enough context to be costly, and
 * isn't mid-turn or awaiting input. Dismissal is a local hide, not a persisted
 * property — see evaluateStalePrompt.
 *
 * SessionChatColumn is a persistent holder that is NOT keyed by sessionId, so all
 * mutable state here is reset when the conversation changes; otherwise a previous
 * conversation's Ignore / activity signal would bleed into the next one and wrongly
 * suppress a prompt it independently earns.
 */
export function useStaleSession({
  sessionId,
  agentSlug,
  isActive,
  isWaitingBackground,
  isAwaitingInput,
  isViewOnly,
  lastActivityAt,
  contextUsage,
}: UseStaleSessionArgs): UseStaleSessionResult {
  const navigate = useNavigate()
  const draftStore = useDraftsStore()

  // `lastActivityAt` comes from the session-detail query, which only refreshes on
  // metadata changes / remount — not when a turn completes. So after the user sends
  // and the agent replies, it still reads the pre-send time, and the prompt would
  // immediately re-trip the moment the session goes idle. Track the live active->idle
  // transition as a fresher activity signal (set while active and at the instant it
  // goes idle) so a just-finished turn resets the idle clock.
  const [liveActivityAt, setLiveActivityAt] = useState<number | null>(null)
  const wasActiveRef = useRef(isActive)
  useEffect(() => {
    if (isActive || wasActiveRef.current) setLiveActivityAt(Date.now())
    wasActiveRef.current = isActive
  }, [isActive])

  const isRunning = isActive && !isWaitingBackground
  const shouldPrompt = useMemo(() => {
    const activityMs = Math.max(lastActivityAt?.getTime() ?? 0, liveActivityAt ?? 0)
    return evaluateStalePrompt({
      idleMs: activityMs ? Date.now() - activityMs : 0,
      contextTokens: currentContextTokens(contextUsage),
      isAwaitingInput,
      isRunning,
    }).shouldPrompt
  }, [lastActivityAt, liveActivityAt, contextUsage, isAwaitingInput, isRunning])

  // Local Ignore (no persistence) + Learn more popover open-state (drives FAB suppression).
  const [ignored, setIgnored] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Reset all stale-prompt state when the conversation changes (see the holder note above).
  useEffect(() => {
    setIgnored(false)
    setMenuOpen(false)
    setLiveActivityAt(null)
    wasActiveRef.current = isActive
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Getter for the in-session composer's live state, registered by MessageInput.
  // "Start fresh" reads it to carry text + files + model + effort into the new chat.
  const composerSnapshotRef = useRef<(() => ComposerSnapshot) | null>(null)
  const registerSnapshot = useCallback((getSnapshot: (() => ComposerSnapshot) | null) => {
    composerSnapshotRef.current = getSnapshot
  }, [])

  // Move the live composer (text + files + model + effort) into the agent's new-chat
  // composer and clear the source draft — a move, not a copy.
  const startFresh = useCallback(() => {
    const { draftText, carryover } = splitSnapshotForHandoff(composerSnapshotRef.current?.())
    if (draftText !== undefined) draftStore.set(`agent:${agentSlug}`, draftText)
    draftStore.set(carryoverKey(agentSlug), carryover)
    draftStore.set(`session:${sessionId}`, undefined)
    void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
  }, [agentSlug, sessionId, draftStore, navigate])

  // The toast owns the footer slot only at rest; once active, the activity indicator
  // owns it instead. View-only users can't start fresh, so they never see it. Ignore
  // is a local hide; it can return on a later qualifying mount, and a plain send
  // clears it as the idle gate resets.
  const showToast = shouldPrompt && !isActive && !isViewOnly && !ignored

  return {
    showToast,
    ignore: useCallback(() => setIgnored(true), []),
    menuOpen,
    setMenuOpen,
    registerSnapshot,
    startFresh,
  }
}
