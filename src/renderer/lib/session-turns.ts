import { useSyncExternalStore } from 'react'

/**
 * How many turns each session has started, as its stream reports them. Kept
 * apart from the stream hook so a reader needs no open stream and none of what
 * the stream depends on: the file preview only wants to know a turn began.
 */
const turns = new Map<string, number>()
const listeners = new Set<() => void>()

/** The session's stream saw a new turn start, or took a snapshot that may hide one. */
export function noteTurnStarted(sessionId: string): void {
  turns.set(sessionId, (turns.get(sessionId) ?? 0) + 1)
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A number that changes whenever a new turn starts in the session. */
export function useSessionTurn(sessionId: string | null): number {
  return useSyncExternalStore(subscribe, () => (sessionId ? turns.get(sessionId) ?? 0 : 0))
}
