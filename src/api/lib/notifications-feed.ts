import { isAuthMode } from '@shared/lib/auth/mode'
import { globalFeed, type GlobalFeedEvent } from '@shared/lib/notifications/global-feed'
import { isCollaborationEvent } from '@shared/lib/services/collaboration-events'
import { getAccessibleAgentSlugs } from '@shared/lib/services/notification-service'
import { createAgentAccessGate, type AgentAccessGate } from './agent-access-gate'

/**
 * One open notifications stream's view of the global feed, for the SSE route
 * and the notifications socket alike. Returns the function that ends it.
 */
export function openNotificationsFeed(options: {
  user: { id: string } | undefined
  deliver: (event: GlobalFeedEvent) => void
  /** The user's agents could not be loaded: end the stream so the client reconnects with a fresh load. */
  onLoadError: () => void
}): () => void {
  const { user, deliver } = options
  let gate: AgentAccessGate | null = null
  // In auth mode the stream carries only the agents the user can access
  // (admins included). Without a user there is nothing to scope by.
  if (isAuthMode() && user) {
    gate = createAgentAccessGate({
      load: () => getAccessibleAgentSlugs(user.id),
      deliver,
      onLoadError: (error) => {
        console.error('Failed to load accessible agents for the notifications stream:', error)
        options.onLoadError()
      },
    })
  }
  const scoped = gate
  const unsubscribe = globalFeed.subscribe((event) => {
    // A targeted frame (a mention, a membership change) goes to its recipient alone.
    if (user && event.recipientUserId !== undefined && event.recipientUserId !== user.id) return
    if (isCollaborationEvent(event)) {
      // It can grant or revoke this user's access, and a revoked user must still hear it.
      scoped?.refresh()
      deliver(event)
      return
    }
    if (scoped) scoped.push(event)
    else deliver(event)
  })
  return () => {
    unsubscribe()
    gate?.dispose()
  }
}
