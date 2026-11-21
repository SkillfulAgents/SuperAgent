/**
 * What a session's side drawer had open, kept while the app runs so that
 * leaving a session and coming back finds the same tabs. Memory only: it is
 * gone on reload, and holds the most recently left sessions.
 */
const SESSION_LIMIT = 50

export interface SessionMemory<T> {
  get: (sessionId: string) => T | undefined
  set: (sessionId: string, value: T) => void
  clear: () => void
}

export function createSessionMemory<T>(): SessionMemory<T> {
  const entries = new Map<string, T>()
  return {
    get: sessionId => entries.get(sessionId),
    set: (sessionId, value) => {
      // Re-inserting moves the session to the newest end; the oldest falls off.
      entries.delete(sessionId)
      entries.set(sessionId, value)
      if (entries.size > SESSION_LIMIT) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },
    clear: () => entries.clear(),
  }
}

/**
 * A request to bring one drawer tab to the front. `seq` changes on every
 * request, so asking for a tab that is already selected still counts.
 */
export interface TrayFocus {
  key: string
  seq: number
}

export function nextFocus(previous: TrayFocus | null, key: string): TrayFocus {
  return { key, seq: (previous?.seq ?? 0) + 1 }
}
