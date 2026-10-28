/**
 * Notifies the app that a cloud workspace request came back 401.
 *
 * Needed because a rejected request and the *session* are two different pieces
 * of state. In web auth mode a 401 signs out, which collapses them. In cloud
 * mode signing out is exactly what must not happen — so without a signal, the
 * Better Auth session store keeps its last good value, `AuthGate` stays mounted,
 * and the user watches every query fail behind a UI that still claims to be
 * signed in.
 *
 * The listener re-fetches the session, which resolves the disagreement honestly:
 * if the workspace token really is dead, `/api/auth/get-session` 401s too and
 * Better Auth nulls the session, which is what surfaces `<WorkspaceReconnect/>`.
 * If it was a one-off, the session survives and nothing changes.
 *
 * No loop risk: Better Auth uses its own fetch, so the re-fetch never returns
 * through `apiFetch`.
 */

type Listener = () => void

const listeners = new Set<Listener>()

/**
 * A dead token 401s every in-flight query at once. One re-fetch answers all of
 * them, so collapse a burst into a single check.
 */
const COALESCE_MS = 5_000
let lastReportedAt = 0

/** Called by `apiFetch` when a cloud request 401s despite the proxy's re-mint. */
export function reportCloudSessionRejected(): void {
  const now = Date.now()
  if (now - lastReportedAt < COALESCE_MS) return
  lastReportedAt = now
  for (const listener of [...listeners]) listener()
}

/** Subscribe; returns an unsubscribe. */
export function onCloudSessionRejected(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drops subscribers and the coalescing window. */
export function _resetCloudSessionForTest(): void {
  listeners.clear()
  lastReportedAt = 0
}
