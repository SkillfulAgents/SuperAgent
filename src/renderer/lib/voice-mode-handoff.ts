import { useSyncExternalStore } from 'react'

/**
 * Voice mode, seen from outside the composer.
 *
 * Two things: the note the agent home leaves when its voice button creates a
 * session (the session's composer must come up in voice mode without sending
 * a second "entered voice mode" notice — the session's first message already
 * is one), and which sessions have voice mode on right now, for the parts of
 * the session view that draw differently around the mic (the activity card
 * with no composer box to dock to, the keyboard hints). Module state, like
 * the pending-message ghost, because the home page is gone by the time the
 * composer mounts.
 */
const requested = new Set<string>()

export function requestVoiceMode(sessionId: string): void {
  requested.add(sessionId)
}

/** Whether voice mode was requested for `sessionId`. Does not clear it. */
export function isVoiceModeRequested(sessionId: string): boolean {
  return requested.has(sessionId)
}

export function clearVoiceModeRequest(sessionId: string): void {
  requested.delete(sessionId)
}

const active = new Set<string>()
const listeners = new Set<() => void>()

export function setVoiceModeActive(sessionId: string, on: boolean): void {
  const was = active.has(sessionId)
  if (on) active.add(sessionId)
  else active.delete(sessionId)
  if (was !== on) for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether `sessionId` currently has voice mode on. */
export function useIsVoiceModeActive(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? active.has(sessionId) : false),
    () => false,
  )
}
