/**
 * Session-scoped registry that lets distant components (e.g. the file-preview
 * comment bar) focus the message composer without querying the DOM for it.
 * The composer registers its focus handler on mount; callers look it up by
 * session id. At most one composer is mounted per session.
 */
type FocusComposer = () => void

const focusFns = new Map<string, FocusComposer>()

export function registerSessionComposerFocus(sessionId: string, focus: FocusComposer): () => void {
  focusFns.set(sessionId, focus)
  return () => {
    // Only delete our own entry — a remount may have registered a newer
    // handler under the same session id before this cleanup runs.
    if (focusFns.get(sessionId) === focus) focusFns.delete(sessionId)
  }
}

/** Focus the composer for a session, if one is mounted. No-op otherwise. */
export function focusSessionComposer(sessionId: string): void {
  focusFns.get(sessionId)?.()
}
