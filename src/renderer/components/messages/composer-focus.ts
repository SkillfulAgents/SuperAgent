/**
 * Session-scoped registry that lets distant components (e.g. the file-preview
 * comment bar, the thread drawer) reach the message composer without querying
 * the DOM for it: focus it, or put text in it. The composer registers its
 * handlers on mount; callers look them up by session id. At most one composer
 * is mounted per session.
 */
type FocusComposer = () => void
/** Add text to the draft (after anything already typed) and focus the composer. */
type FillComposer = (text: string) => void

const focusFns = new Map<string, FocusComposer>()
const fillFns = new Map<string, FillComposer>()

function register<T>(registry: Map<string, T>, sessionId: string, handler: T): () => void {
  registry.set(sessionId, handler)
  return () => {
    // Only delete our own entry — a remount may have registered a newer
    // handler under the same session id before this cleanup runs.
    if (registry.get(sessionId) === handler) registry.delete(sessionId)
  }
}

export function registerSessionComposerFocus(sessionId: string, focus: FocusComposer): () => void {
  return register(focusFns, sessionId, focus)
}

/** Focus the composer for a session, if one is mounted. No-op otherwise. */
export function focusSessionComposer(sessionId: string): void {
  focusFns.get(sessionId)?.()
}

export function registerSessionComposerFill(sessionId: string, fill: FillComposer): () => void {
  return register(fillFns, sessionId, fill)
}

/** Put text in the session's composer, if one is mounted. Says whether one was. */
export function fillSessionComposer(sessionId: string, text: string): boolean {
  const fill = fillFns.get(sessionId)
  fill?.(text)
  return !!fill
}
