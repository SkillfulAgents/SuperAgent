/**
 * The global feed: app-wide live hints for every connected client (session and
 * agent status for the sidebar, notifications, schedule and widget changes).
 * The notifications stream route is its reader; it carries the hints to each
 * client over SSE.
 *
 * It is a facade over AppState PubSub, so a hint published by one process
 * reaches a client that another process serves. Delivery is asynchronous and
 * best-effort: `publish` returns before any listener runs, and nothing is
 * retained, so a client that was not connected refetches. Work that must
 * happen because of an event is not a listener: its owner runs it directly
 * (the host runs the post-run widget sweep and the chat review card from the
 * actor's event; see host/local-host-port.ts).
 *
 * An event about one agent names it at the top level (`agentSlug`); an event
 * for one person names them the same way (`recipientUserId`). The feed picks
 * the event's channel from exactly those fields, so neither may be nested
 * inside another field:
 *
 * - user (`events:feed:user`, one channel per user): an event with a
 *   `recipientUserId` (a mention, its withdrawal), and what `publishToUsers`
 *   addresses (membership changes, a new agent to its members). Only that
 *   user's streams subscribe to it.
 * - agent (`events:feed:agent`, one channel per agent): any other event with
 *   an `agentSlug` (metadata, runtime and session status, requests, background
 *   tasks, shared notifications, schedules, triggers, dashboards, widgets).
 *   A stream subscribes to the agents its user may access.
 * - tenant (`events:feed:tenant`): an event that names neither (runtime
 *   readiness, system alerts, the webhook relay, drives, platform
 *   notifications). Every stream subscribes to it.
 *
 * Local mode (no auth) has one principal and no access lists: every client may
 * see every event, so every event goes on the tenant channel.
 */
import { z } from 'zod'
import { appState, defineTopic, isAppStateInitialized, type AppState, type Channel, type SubscribeOptions, type Subscription } from '@shared/lib/app-state'
import { isAuthMode } from '@shared/lib/auth/mode'
import { background } from '@shared/lib/background'

export interface GlobalFeedEvent {
  type: string
  agentSlug?: string
  recipientUserId?: string
  [key: string]: unknown
}

export type GlobalFeedListener = (event: GlobalFeedEvent) => void

const feedEventSchema: z.ZodType<GlobalFeedEvent> = z
  .object({
    type: z.string().min(1),
    agentSlug: z.string().optional(),
    recipientUserId: z.string().optional(),
  })
  .catchall(z.unknown())

const tenantTopic = defineTopic({ name: 'events:feed:tenant', schema: feedEventSchema })
const agentTopic = defineTopic({ name: 'events:feed:agent', schema: feedEventSchema })
const userTopic = defineTopic({ name: 'events:feed:user', schema: feedEventSchema })

/** Events that name no agent and no person: every stream follows it. */
export function tenantFeedChannel(): Channel<GlobalFeedEvent> {
  return tenantTopic.channel('all')
}

/** One agent's events: the streams of the users who may access it follow it. */
export function agentFeedChannel(agentSlug: string): Channel<GlobalFeedEvent> {
  return agentTopic.channel(agentSlug)
}

/** One user's events: only that user's streams follow it. */
export function userFeedChannel(userId: string): Channel<GlobalFeedEvent> {
  return userTopic.channel(userId)
}

/** The channel an event goes on, from its top-level `recipientUserId` and `agentSlug`. */
export function feedChannelOf(event: GlobalFeedEvent): Channel<GlobalFeedEvent> {
  if (!isAuthMode()) return tenantFeedChannel()
  if (event.recipientUserId) return userFeedChannel(event.recipientUserId)
  if (event.agentSlug) return agentFeedChannel(event.agentSlug)
  return tenantFeedChannel()
}

/** The installed AppState, or null before an entry point initialized it. */
function installedAppState(): AppState | null {
  return isAppStateInitialized() ? appState() : null
}

export class GlobalFeed {
  private readonly publishedHooks = new Set<GlobalFeedListener>()

  /** `state` is looked up at each use; a test passes another process's client. */
  constructor(private readonly state: () => AppState | null = installedAppState) {}

  /**
   * Work this process must do because of an event it raises itself. The hook
   * runs inside `publish`, in the publishing process only, before the event is
   * handed to AppState: it does not depend on delivery, as a subscriber does.
   * It must not throw and must start anything slow in the background.
   */
  onPublished(hook: GlobalFeedListener): () => void {
    this.publishedHooks.add(hook)
    return () => {
      this.publishedHooks.delete(hook)
    }
  }

  /**
   * Hand the event to AppState for its channel and return at once. The
   * listeners run later; a failure to publish is reported, never thrown at
   * the publisher.
   */
  publish(event: GlobalFeedEvent): void {
    for (const hook of this.publishedHooks) {
      try {
        hook(event)
      } catch (error) {
        console.error('[GlobalFeed] A published hook failed:', error)
      }
    }
    this.send([feedChannelOf(event)], event)
  }

  /**
   * The event for these users alone, on their own channels, whatever agent it
   * names: a membership change, which must reach a user who just lost access
   * to the agent, and a new agent, which its members' streams do not follow
   * yet. The payload is sent as it is. In local mode the one principal's
   * streams all follow the tenant channel.
   */
  publishToUsers(userIds: Iterable<string>, event: GlobalFeedEvent): void {
    const recipients = [...new Set(userIds)]
    if (recipients.length === 0) return
    this.send(isAuthMode() ? recipients.map(userFeedChannel) : [tenantFeedChannel()], event)
  }

  /**
   * Follow these channels until the subscription ends: `unsubscribe()`, or
   * `options.signal` aborting (also while this is still setting up).
   * Resolves once events published from then on reach `listener`.
   */
  subscribe(
    channels: readonly Channel<GlobalFeedEvent>[],
    listener: GlobalFeedListener,
    options?: SubscribeOptions,
  ): Promise<Subscription> {
    const state = this.state()
    if (!state) return Promise.reject(new Error('The global feed needs AppState, which is not initialized'))
    return state.subscribe(channels, (event) => listener(event), options)
  }

  private send(channels: readonly Channel<GlobalFeedEvent>[], event: GlobalFeedEvent): void {
    // Nothing can be subscribed before AppState exists, so there is no one to
    // tell (a test fixture that runs before the shared setup installs it).
    const state = this.state()
    if (!state) return
    // Started now, so events one process publishes are accepted in the order
    // it published them.
    background(() => Promise.all(channels.map((channel) => state.publish(channel, event))), { name: 'global-feed.publish' })
  }
}

export const globalFeed = new GlobalFeed()
