import type { Subscription } from '@shared/lib/app-state'
import { isAuthMode } from '@shared/lib/auth/mode'
import {
  agentFeedChannel,
  globalFeed,
  tenantFeedChannel,
  userFeedChannel,
  type GlobalFeedEvent,
} from '@shared/lib/notifications/global-feed'
import { isCollaborationEvent } from '@shared/lib/services/collaboration-events'
import { getAccessibleAgentSlugs } from '@shared/lib/services/notification-service'
import { createAgentAccessGate } from './agent-access-gate'

/**
 * One notifications stream's view of the global feed: the channels its user
 * may see, followed through AppState, with every event judged again here.
 *
 * In auth mode a stream follows the tenant's channel, its user's own channel
 * and the channel of each agent the user can access. The access gate loads
 * those agents when the stream opens, again when a hint says they may have
 * changed (a membership change, a new agent on the user's channel) and on its
 * period; each load first follows the agents it found and leaves the ones it
 * did not, so a revoked agent's channel is left and a new one's followed.
 * Events still pass the gate and the recipient check: a follow is routing,
 * never the access decision.
 *
 * In local mode there is one principal and every event is on the tenant's
 * channel, so a stream follows that alone.
 *
 * Resolves once the stream follows its channels (in auth mode, after the
 * first load), so events published from then on reach it.
 */
export async function openNotificationsFeed(options: {
  user: { id: string } | undefined
  deliver: (event: GlobalFeedEvent) => void
  /** Ends every subscription, also one still being set up when it aborts. */
  signal: AbortSignal
  /** The user's agents could not be loaded or followed: end the stream so the client reconnects with a fresh load. */
  onLoadError: () => void
}): Promise<void> {
  const { user, deliver, signal } = options
  // Without a user (auth mode always has one behind Authenticated) nothing
  // names who the stream is for, so it carries only what is for everyone.
  if (!isAuthMode() || !user) {
    await globalFeed.subscribe([tenantFeedChannel()], deliver, { signal })
    return
  }
  const userId = user.id

  // The agent channels followed, by slug. Changed only by the gate's loads,
  // which run one at a time.
  const following = new Map<string, Promise<Subscription>>()
  const follow = async (slugs: readonly string[]): Promise<void> => {
    const wanted = new Set(slugs)
    const changes: Promise<unknown>[] = []
    for (const [slug, subscription] of following) {
      if (wanted.has(slug)) continue
      following.delete(slug)
      changes.push(subscription.then((ended) => ended.unsubscribe()))
    }
    for (const slug of wanted) {
      if (following.has(slug)) continue
      const subscription = globalFeed.subscribe([agentFeedChannel(slug)], onEvent, { signal })
      following.set(slug, subscription)
      changes.push(subscription)
    }
    await Promise.all(changes)
  }

  const gate = createAgentAccessGate({
    load: async () => {
      const slugs = await getAccessibleAgentSlugs(userId)
      await follow(slugs)
      return slugs
    },
    deliver,
    onLoadError: (error) => {
      // Without the list nothing about an agent can be judged; the
      // client reconnects and the next stream loads it again.
      console.error('Failed to load accessible agents for the notifications stream:', error)
      options.onLoadError()
    },
  })
  if (signal.aborted) gate.dispose()
  else signal.addEventListener('abort', () => gate.dispose(), { once: true })

  function onEvent(event: GlobalFeedEvent): void {
    // A targeted frame goes to its recipient alone.
    if (event.recipientUserId !== undefined && event.recipientUserId !== userId) return
    if (isCollaborationEvent(event)) {
      // It can grant or revoke this user's access, and a user who lost access
      // must still hear of it, so it skips the gate and reloads it.
      gate.refresh()
      deliver(event)
      return
    }
    gate.push(event)
  }

  await Promise.all([
    globalFeed.subscribe([tenantFeedChannel(), userFeedChannel(userId)], onEvent, { signal }),
    gate.ready,
  ])
}
